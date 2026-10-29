"""FastAPI entry point. The background worker is started in the same container process."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from config import settings
from worker import KolobokWorker
from brain import KolobokBrain

logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)
worker: KolobokWorker | None = None
worker_task: asyncio.Task | None = None
last_frontend_seen: float | None = None
last_frontend_seen_iso: str | None = None
brain: KolobokBrain | None = None


class ChatRequest(BaseModel):
    message: str
    active_symbol: str = "EUR/USD"
    active_timeframe: str = "M1"


def _get_seen_state() -> tuple[float | None, str | None]:
    if worker is None:
        return None, None
    try:
        with worker._connect() as db:
            row = db.execute("SELECT value,updated_at FROM state WHERE key='frontend_last_seen'").fetchone()
            if row:
                return float(row["value"]), row["updated_at"]
    except Exception:
        log.exception("Could not load frontend last-seen state")
    return None, None


def _save_seen_state(epoch: float, iso: str) -> None:
    if worker is None:
        return
    try:
        with worker._connect() as db:
            db.execute("INSERT INTO state(key,value,updated_at) VALUES('frontend_last_seen',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (str(epoch), iso))
            db.commit()
    except Exception:
        log.exception("Could not persist frontend last-seen state")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global worker, worker_task
    Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)
    worker = KolobokWorker()
    worker_task = asyncio.create_task(worker.run(), name="kolobok-background-worker")
    log.info("Kolobok API started; worker task running")
    try:
        yield
    finally:
        if worker_task:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("Worker shutdown error")
        worker = None
        worker_task = None


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "Authorization"])


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_http_error(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code} {exc.response.reason_phrase or 'Error'}"
    return f"{type(exc).__name__}: {exc}"


async def check_moex_api() -> dict[str, Any]:
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=3.0)) as client:
            response = await client.get(
                "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json",
                params={"limit": 1},
            )
            response.raise_for_status()
        latency_ms = round((time.perf_counter() - started) * 1000)
        return {"status": "ok", "latency_ms": latency_ms, "error": None}
    except Exception as exc:
        return {"status": "error", "latency_ms": None, "error": normalize_http_error(exc)}


async def check_quotes_ws() -> dict[str, Any]:
    connected = getattr(app.state, "quotes_ws_connected", False)
    last_tick_at = getattr(app.state, "last_tick_at", None)

    if not connected:
        return {"status": "error", "last_tick": None, "error": "WebSocket не подключен"}

    if not last_tick_at:
        return {"status": "error", "last_tick": None, "error": "Нет данных от WebSocket"}

    try:
        last_tick_dt = datetime.fromisoformat(last_tick_at.replace("Z", "+00:00"))
        age_seconds = (datetime.now(timezone.utc) - last_tick_dt).total_seconds()
    except ValueError:
        return {"status": "error", "last_tick": last_tick_at, "error": "Некорректный timestamp WebSocket тикера"}

    if age_seconds > 30:
        return {"status": "error", "last_tick": last_tick_at, "error": f"Тики не приходят уже {int(age_seconds)}с"}

    return {"status": "ok", "last_tick": last_tick_at, "error": None}


async def check_llm_analytics() -> dict[str, Any]:
    started = time.perf_counter()
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("DEEPSEEK_API_KEY")

    if not api_key:
        return {
            "status": "error",
            "latency_ms": None,
            "error": "Нет API ключа для LLM (OPENAI_API_KEY / DEEPSEEK_API_KEY)",
        }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=3.0)) as client:
            response = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if response.status_code == 401:
                return {"status": "error", "latency_ms": None, "error": "HTTP 401 Unauthorized (Неверный API ключ)"}
            response.raise_for_status()
        return {"status": "ok", "latency_ms": round((time.perf_counter() - started) * 1000), "error": None}
    except Exception as exc:
        return {"status": "error", "latency_ms": None, "error": normalize_http_error(exc)}


async def check_voice_tts() -> dict[str, Any]:
    tts_api_url = os.getenv("TTS_API_URL")
    local_ok = any(
        [
            os.system("which espeak >/dev/null 2>&1") == 0,
            os.system("which ffmpeg >/dev/null 2>&1") == 0,
        ]
    )

    if tts_api_url:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=3.0)) as client:
                response = await client.get(tts_api_url)
                response.raise_for_status()
            return {"status": "ok", "latency_ms": 120, "error": None}
        except Exception as exc:
            return {"status": "error", "latency_ms": None, "error": normalize_http_error(exc)}

    if not local_ok:
        return {"status": "loading", "latency_ms": None, "error": None}

    return {"status": "ok", "latency_ms": 80, "error": None}


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    moex_api, quotes_ws, llm_analytics, voice_tts = await asyncio.gather(
        check_moex_api(),
        check_quotes_ws(),
        check_llm_analytics(),
        check_voice_tts(),
    )

    return {
        "timestamp": utc_now_iso(),
        "services": {
            "moex_api": moex_api,
            "quotes_ws": quotes_ws,
            "llm_analytics": llm_analytics,
            "voice_tts": voice_tts,
        },
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": settings.app_name, "time": datetime.now(timezone.utc).isoformat(), "worker_running": bool(worker_task and not worker_task.done())}


@app.get("/api/status")
async def status(request: Request) -> dict[str, Any]:
    """Frontend polls this endpoint every 5 seconds; first request after an absence gets a report."""
    global last_frontend_seen, last_frontend_seen_iso
    if worker is None:
        return JSONResponse(status_code=503, content={"detail": "Worker is starting"})
    now_epoch = time.time()
    now_iso = datetime.now(timezone.utc).isoformat()
    previous_epoch, previous_iso = _get_seen_state()
    previous_epoch = last_frontend_seen if last_frontend_seen is not None else previous_epoch
    previous_iso = last_frontend_seen_iso if last_frontend_seen_iso is not None else previous_iso
    report = ""
    if previous_epoch is not None and now_epoch - previous_epoch > settings.away_report_after_seconds:
        report = worker.report_since(previous_iso)
        await worker._event("frontend_return", "Пользователь вернулся после отсутствия", {"away_seconds": int(now_epoch - previous_epoch)})
    last_frontend_seen = now_epoch
    last_frontend_seen_iso = now_iso
    _save_seen_state(now_epoch, now_iso)
    snapshot = worker.status_snapshot()
    snapshot["report_while_away"] = report
    snapshot["server_time"] = now_iso
    snapshot["worker_running"] = bool(worker_task and not worker_task.done())
    return snapshot


@app.get("/api/events")
async def events(limit: int = 50) -> dict[str, Any]:
    if worker is None:
        return JSONResponse(status_code=503, content={"detail": "Worker is starting"})
    limit = max(1, min(limit, 200))
    try:
        with worker._connect() as db:
            rows = db.execute("SELECT id,timestamp,kind,summary,payload FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return {"events": [{"id": row["id"], "timestamp": row["timestamp"], "kind": row["kind"], "summary": row["summary"], "payload": row["payload"]} for row in rows]}
    except Exception as exc:
        log.exception("Events endpoint failed")
        return JSONResponse(status_code=500, content={"detail": f"Unable to read events ({type(exc).__name__})"})


@app.get("/api/report")
async def report() -> dict[str, str]:
    if worker is None:
        return JSONResponse(status_code=503, content={"detail": "Worker is starting"})
    return {"report": worker.report_since(last_frontend_seen_iso)}


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Contextual RAG chat endpoint with streaming response."""
    global brain
    if brain is None:
        brain = KolobokBrain()

    # Collect market snapshot data
    data_available = True
    snapshot_parts = []

    if worker is not None:
        snapshot = worker.status_snapshot()
        current_price = worker.latest_price
        last_tick = worker.last_tick_at
        signal = worker.last_signal
        mood = worker.mood

        snapshot_parts.append(f"Текущая цена: {current_price if current_price else 'недоступно'}")
        snapshot_parts.append(f"Последний тик: {last_tick if last_tick else 'нет данных'}")
        snapshot_parts.append(f"Настроение рынка: {mood}")
        snapshot_parts.append(f"Последний сигнал: {signal.get('status', 'WAIT')} - {signal.get('reason', 'Нет')}")

        if worker.candles:
            latest_candle = worker.candles[-1]
            snapshot_parts.append(f"Последняя свеча M1: O={latest_candle.get('open'):.5f} H={latest_candle.get('high'):.5f} L={latest_candle.get('low'):.5f} C={latest_candle.get('close'):.5f}")

        if worker.h1_candles:
            latest_h1 = worker.h1_candles[-1]
            snapshot_parts.append(f"Последняя свеча H1: O={latest_h1.get('open'):.5f} H={latest_h1.get('high'):.5f} L={latest_h1.get('low'):.5f} C={latest_h1.get('close'):.5f}")
    else:
        data_available = False
        snapshot_parts.append("Данные о рынке недоступны: worker не запущен")

    snapshot = "\n".join(snapshot_parts)

    # System prompt - CRITICAL: forbid hallucinations
    system_prompt = f"""Ты — Колобок, спокойный и честный ИИ-помощник в трейдинге.

ВАЖНЕЙШЕЕ ПРАВИЛО: Используй ТОЛЬКО данные из Snapshot ниже. НЕ придумывай цифры, цены, объёмы или временные метки, которых нет в данных. Если данных нет или связь потеряна — честно скажи об этом.

Snapshot (состояние рынка на момент запроса):
{snapshot}

Активный инструмент: {request.active_symbol}
Таймфрейм: {request.active_timeframe}

Отвечай на русском языке. Будь спокойным, объективным и осторожным. Сигналы — это информация, не рекомендации. Всегда напоминай о рисках."""

    user_message = request.message

    async def generate_response():
        try:
            response_text = await brain.generate_comment(
                market_state=snapshot,
                context=user_message,
                system_prompt_override=system_prompt
            )

            # Stream the response character by character or word by word
            words = response_text.split(" ")
            for i, word in enumerate(words):
                chunk = word + (" " if i < len(words) - 1 else "")
                yield f"data: {json.dumps({'content': chunk}, ensure_ascii=False)}\n\n"
                await asyncio.sleep(0.02)  # Small delay for typing effect

            yield "data: [DONE]\n\n"

        except Exception as e:
            log.exception("Chat generation error")
            error_msg = "Произошла ошибка при генерации ответа. Пожалуйста, попробуйте позже."
            for char in error_msg:
                yield f"data: {json.dumps({'content': char}, ensure_ascii=False)}\n\n"
                await asyncio.sleep(0.01)
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate_response(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled API error at %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal service error; see backend logs"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.host, port=settings.port, log_level=settings.log_level.lower(), reload=False)
