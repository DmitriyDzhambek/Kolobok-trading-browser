"""FastAPI entry point. The background worker is started in the same container process."""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from worker import KolobokWorker

logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)
worker: KolobokWorker | None = None
worker_task: asyncio.Task | None = None
last_frontend_seen: float | None = None
last_frontend_seen_iso: str | None = None


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
    # In-memory values make same-process polling cheap; persisted values survive restarts.
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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled API error at %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal service error; see backend logs"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.host, port=settings.port, log_level=settings.log_level.lower(), reload=False)
