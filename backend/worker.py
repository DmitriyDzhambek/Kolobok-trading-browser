"""Always-on EUR/USD M1 worker using Twelve Data WebSocket quotes.

Forex does not have one centralized exchange volume. Tick counts are recorded as a
proxy and are never labelled as true traded volume. If no API key is configured,
the worker stays healthy but reports that live market data is unavailable.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets

from brain import KolobokBrain
from config import settings

log = logging.getLogger(__name__)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class KolobokWorker:
    def __init__(self, database_path: str | None = None, brain: KolobokBrain | None = None) -> None:
        self.database_path = database_path or settings.database_path
        self.brain = brain or KolobokBrain()
        self.candles: deque[dict[str, Any]] = deque(maxlen=30)
        self.h1_candles: deque[dict[str, Any]] = deque(maxlen=240)
        self.latest_price: float | None = None
        self.last_tick_at: str | None = None
        self.last_message = "Колобок на связи. Подключаюсь к потоку котировок."
        self.last_observation_at = 0.0
        self.last_signal: dict[str, Any] = {"status": "WAIT", "entry": None, "sl": None, "tp": None, "reason": "Ожидание подтверждённого сигнала"}
        self.mood = "sleeping"
        self.source_status = "not_configured" if not settings.twelvedata_api_key else "connecting"
        self._last_closed_minute: int | None = None
        self._current_minute: dict[str, Any] | None = None
        self._last_signal_key: str | None = None
        self._last_payload: dict[str, Any] = {}
        self._db_lock = asyncio.Lock()
        self._init_db()
        self._restore_state()

    def _connect(self) -> sqlite3.Connection:
        Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.database_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS candles (
                minute INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, open REAL NOT NULL,
                high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
                tick_volume INTEGER NOT NULL, source TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS state (
                key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)")

    def _restore_state(self) -> None:
        try:
            with self._connect() as db:
                rows = db.execute("SELECT * FROM candles ORDER BY minute DESC LIMIT 20160").fetchall()
                restored = []
                for row in reversed(rows):
                    candle = {"minute": row["minute"], "time": row["timestamp"], "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"], "tick_volume": row["tick_volume"]}
                    restored.append(candle)
                    if len(restored) > len(rows) - 31:
                        self.candles.append(candle)
                hourly: dict[int, dict[str, Any]] = {}
                for candle in restored:
                    hour = candle["minute"] // 60
                    if hour not in hourly:
                        hourly[hour] = {"minute": hour * 60, "time": candle["time"], "open": candle["open"], "high": candle["high"], "low": candle["low"], "close": candle["close"], "tick_volume": candle["tick_volume"]}
                    else:
                        hourly[hour]["high"] = max(hourly[hour]["high"], candle["high"])
                        hourly[hour]["low"] = min(hourly[hour]["low"], candle["low"])
                        hourly[hour]["close"] = candle["close"]
                        hourly[hour]["tick_volume"] += candle["tick_volume"]
                self.h1_candles.extend(hourly[key] for key in sorted(hourly))
                state = db.execute("SELECT value FROM state WHERE key='runtime'").fetchone()
                if state:
                    data = json.loads(state["value"])
                    self.last_message = data.get("last_message", self.last_message)
                    self.last_signal = data.get("last_signal", self.last_signal)
                    self.mood = data.get("mood", self.mood)
        except (sqlite3.Error, ValueError, TypeError) as exc:
            log.warning("Could not restore previous state: %s", exc)

    async def _save_state(self) -> None:
        payload = json.dumps({"last_message": self.last_message, "last_signal": self.last_signal, "mood": self.mood}, ensure_ascii=False)
        async with self._db_lock:
            with self._connect() as db:
                db.execute("INSERT INTO state(key,value,updated_at) VALUES('runtime',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (payload, utc_now()))

    async def _event(self, kind: str, summary: str, payload: dict[str, Any]) -> None:
        async with self._db_lock:
            with self._connect() as db:
                db.execute("INSERT INTO events(timestamp,kind,summary,payload) VALUES(?,?,?,?)", (utc_now(), kind, summary, json.dumps(payload, ensure_ascii=False)))

    @staticmethod
    def _ema(values: list[float], period: int) -> float | None:
        if len(values) < period:
            return None
        alpha = 2 / (period + 1)
        value = sum(values[:period]) / period
        for point in values[period:]:
            value = point * alpha + value * (1 - alpha)
        return value

    @staticmethod
    def _rsi(values: list[float], period: int = 14) -> float | None:
        if len(values) <= period:
            return None
        changes = [values[i] - values[i - 1] for i in range(1, len(values))]
        gains = sum(max(x, 0) for x in changes[-period:]) / period
        losses = sum(max(-x, 0) for x in changes[-period:]) / period
        if losses == 0:
            return 100.0 if gains else 50.0
        return 100 - (100 / (1 + gains / losses))

    def _analysis(self) -> dict[str, Any]:
        candles = list(self.candles)
        closes = [float(c["close"]) for c in candles]
        h1_closes = [float(c["close"]) for c in list(self.h1_candles)[-240:]]
        ema_fast, ema_slow = self._ema(h1_closes, 20), self._ema(h1_closes, 50)
        h1_trend = "восходящий" if ema_fast is not None and ema_slow is not None and ema_fast > ema_slow else "нисходящий" if ema_fast is not None and ema_slow is not None and ema_fast < ema_slow else "не определён (недостаточно часовой истории)"
        recent = candles[-1] if candles else {}
        previous = candles[-2] if len(candles) > 1 else {}
        pattern = "нет подтверждённого паттерна"
        if recent and previous:
            body = abs(recent["close"] - recent["open"])
            span = max(recent["high"] - recent["low"], 1e-9)
            lower_wick = min(recent["open"], recent["close"]) - recent["low"]
            upper_wick = recent["high"] - max(recent["open"], recent["close"])
            if lower_wick > body * 2 and lower_wick / span > 0.55:
                pattern = "возможный бычий пин-бар"
            elif upper_wick > body * 2 and upper_wick / span > 0.55:
                pattern = "возможный медвежий пин-бар"
            elif recent["close"] > recent["open"] and previous["close"] < previous["open"] and recent["close"] >= previous["open"] and recent["open"] <= previous["close"]:
                pattern = "бычье поглощение"
            elif recent["close"] < recent["open"] and previous["close"] > previous["open"] and recent["close"] <= previous["open"] and recent["open"] >= previous["close"]:
                pattern = "медвежье поглощение"
            elif len(candles) >= 8:
                prior = candles[-8:-1]
                floor = min(c["low"] for c in prior)
                ceiling = max(c["high"] for c in prior)
                if recent["low"] < floor and recent["close"] > floor:
                    pattern = "возможный ложный пробой поддержки"
                elif recent["high"] > ceiling and recent["close"] < ceiling:
                    pattern = "возможный ложный пробой сопротивления"
        vols = [int(c.get("tick_volume", 0)) for c in candles[-21:-1]]
        avg_vol = sum(vols) / len(vols) if vols else 0
        current_vol = int(recent.get("tick_volume", 0)) if recent else 0
        volume_spike = avg_vol > 0 and current_vol >= avg_vol * 2.0
        support = round(min((c["low"] for c in candles[-30:]), default=0), 5) or None
        resistance = round(max((c["high"] for c in candles[-30:]), default=0), 5) or None
        rsi = self._rsi(closes)
        signal_status = "WAIT"
        reason = "Нет одновременного подтверждения трендом, паттерном и tick-volume"
        bullish = any(term in pattern for term in ("бычий", "бычье", "ложный пробой поддержки"))
        bearish = any(term in pattern for term in ("медвежий", "медвежье", "ложный пробой сопротивления"))
        if self.latest_price and bullish and volume_spike and h1_trend == "восходящий" and (rsi is None or rsi < 72):
            signal_status, reason = "BUY", f"{pattern}; tick-volume ≥ 2× среднего; тренд H1 восходящий; RSI {rsi:.1f}" if rsi is not None else f"{pattern}; tick-volume spike; тренд H1 восходящий"
        elif self.latest_price and bearish and volume_spike and h1_trend == "нисходящий" and (rsi is None or rsi > 28):
            signal_status, reason = "SELL", f"{pattern}; tick-volume ≥ 2× среднего; тренд H1 нисходящий; RSI {rsi:.1f}" if rsi is not None else f"{pattern}; tick-volume spike; тренд H1 нисходящий"
        entry = float(self.latest_price) if signal_status != "WAIT" else None
        recent_ranges = [max(c["high"] - c["low"], 0) for c in candles[-14:]]
        risk_unit = max(sum(recent_ranges) / len(recent_ranges), entry * 0.0002 if entry else 0.0001) if recent_ranges else (entry * 0.0002 if entry else 0.0001)
        sl = round(entry - risk_unit * 1.5, 5) if entry and signal_status == "BUY" else round(entry + risk_unit * 1.5, 5) if entry and signal_status == "SELL" else None
        tp = round(entry + risk_unit * 2.0, 5) if entry and signal_status == "BUY" else round(entry - risk_unit * 2.0, 5) if entry and signal_status == "SELL" else None
        return {
            "symbol": settings.market_symbol, "price": self.latest_price, "last_tick_at": self.last_tick_at,
            "source_status": self.source_status, "h1_trend": h1_trend, "pattern": pattern,
            "volume": {"current_tick_count": current_vol, "average_tick_count": round(avg_vol, 2), "spike": volume_spike, "kind": "tick_volume_proxy_not_exchange_volume"},
            "levels": {"support": support, "resistance": resistance}, "rsi14": round(rsi, 2) if rsi is not None else None,
            "signal": {"status": signal_status, "entry": entry, "sl": sl, "tp": tp, "reason": reason},
            "candles_m1": candles[-30:],
        }

    async def _close_minute(self, candle: dict[str, Any]) -> None:
        if candle["tick_volume"] <= 0:
            return
        candle["time"] = datetime.fromtimestamp(candle["minute"] * 60, timezone.utc).isoformat()
        self.candles.append(candle.copy())
        hour_key = candle["minute"] // 60
        if self.h1_candles and self.h1_candles[-1]["minute"] // 60 == hour_key:
            hourly = self.h1_candles[-1]
            hourly["high"] = max(hourly["high"], candle["high"])
            hourly["low"] = min(hourly["low"], candle["low"])
            hourly["close"] = candle["close"]
            hourly["tick_volume"] += candle["tick_volume"]
        else:
            self.h1_candles.append({"minute": hour_key * 60, "time": candle["time"], "open": candle["open"], "high": candle["high"], "low": candle["low"], "close": candle["close"], "tick_volume": candle["tick_volume"]})
        async with self._db_lock:
            with self._connect() as db:
                db.execute("INSERT INTO candles(minute,timestamp,open,high,low,close,tick_volume,source) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(minute) DO UPDATE SET high=excluded.high,low=excluded.low,close=excluded.close,tick_volume=excluded.tick_volume", (candle["minute"], candle["time"], candle["open"], candle["high"], candle["low"], candle["close"], candle["tick_volume"], "twelvedata_ws"))
                # Keep durable storage bounded while preserving recent context.
                db.execute("DELETE FROM candles WHERE minute < ?", (candle["minute"] - 60 * 24 * 14,))
        payload = self._analysis()
        self._last_payload = payload
        self.last_signal = payload["signal"]
        self.mood = "alert" if self.last_signal["status"] != "WAIT" else "watching"
        signal_key = f"{candle['minute']}:{self.last_signal['status']}"
        if self.last_signal["status"] != "WAIT" and signal_key != self._last_signal_key:
            self._last_signal_key = signal_key
            await self._event("signal", self.last_signal["reason"], payload)
        self.last_message = await self.brain.commentary(payload)
        await self._event("candle_closed", f"M1 закрылась по цене {candle['close']:.5f}; {payload['pattern']}", payload)
        await self._save_state()
        log.info("M1 close %.5f trend=%s pattern=%s signal=%s", candle["close"], payload["h1_trend"], payload["pattern"], self.last_signal["status"])

    async def on_price(self, price: float) -> None:
        if not math.isfinite(price) or price <= 0:
            return
        now = time.time()
        minute = int(now // 60)
        self.latest_price = price
        self.last_tick_at = utc_now()
        self.source_status = "connected"
        if self._current_minute is None:
            self._current_minute = {"minute": minute, "open": price, "high": price, "low": price, "close": price, "tick_volume": 1}
            return
        if minute == self._current_minute["minute"]:
            self._current_minute["high"] = max(self._current_minute["high"], price)
            self._current_minute["low"] = min(self._current_minute["low"], price)
            self._current_minute["close"] = price
            self._current_minute["tick_volume"] += 1
            return
        old = self._current_minute
        await self._close_minute(old)
        # If connection resumes after a gap, do not fabricate missing candles.
        self._current_minute = {"minute": minute, "open": price, "high": price, "low": price, "close": price, "tick_volume": 1}

    async def _stream_once(self) -> None:
        if not settings.twelvedata_api_key:
            self.source_status = "not_configured"
            self.mood = "sleeping"
            self.last_message = "Я на посту, но для реальных EUR/USD котировок нужен Twelve Data API key. Не буду выдумывать рыночные данные."
            await self._save_state()
            await asyncio.sleep(10)
            return
        url = f"{settings.twelvedata_ws_url}?apikey={settings.twelvedata_api_key}"
        async with websockets.connect(url, ping_interval=20, ping_timeout=20, close_timeout=5, max_size=1_000_000) as ws:
            await ws.send(json.dumps({"action": "subscribe", "params": {"symbols": settings.market_symbol}}))
            self.source_status = "connected"
            log.info("Subscribed to %s live quote stream", settings.market_symbol)
            async for raw in ws:
                try:
                    data = json.loads(raw)
                    if data.get("event") == "error" or data.get("status") == "error":
                        raise RuntimeError(str(data.get("message") or data))
                    if data.get("event") in ("subscribe-status", "heartbeat"):
                        continue
                    price_value = data.get("price") or data.get("close")
                    if price_value is not None:
                        await self.on_price(float(price_value))
                except (json.JSONDecodeError, ValueError, TypeError) as exc:
                    log.warning("Ignoring malformed market message: %s", exc)

    async def _observation_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(max(30, settings.observation_interval_seconds))
                payload = self._analysis() if self.latest_price is not None else {"symbol": settings.market_symbol, "price": None, "source_status": self.source_status, "signal": self.last_signal, "candles_m1": list(self.candles), "h1_trend": "не определён", "pattern": "нет новых рыночных данных", "volume": {"spike": False}, "levels": {}}
                self.last_message = await self.brain.commentary(payload, observation=True)
                self.last_observation_at = time.time()
                self.mood = "watching" if self.latest_price is not None else "sleeping"
                await self._event("observation", self.last_message, payload)
                await self._save_state()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Observation loop error")

    async def run(self) -> None:
        observation_task = asyncio.create_task(self._observation_loop(), name="kolobok-observations")
        backoff = 1.0
        try:
            while True:
                try:
                    await self._stream_once()
                    backoff = 1.0
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.source_status = "disconnected"
                    self.mood = "sleeping"
                    self.last_message = f"Поток котировок временно недоступен. Повторяю подключение; последняя известная цена не считается актуальной. ({type(exc).__name__})"
                    await self._event("feed_error", str(exc), {"source_status": self.source_status})
                    await self._save_state()
                    log.exception("Market stream failed; reconnecting in %.1fs", backoff)
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, settings.reconnect_max_seconds)
        finally:
            observation_task.cancel()
            await asyncio.gather(observation_task, return_exceptions=True)
            await self.brain.close()

    def status_snapshot(self) -> dict[str, Any]:
        payload = self._last_payload or self._analysis()
        stale = not self.last_tick_at or (time.time() - datetime.fromisoformat(self.last_tick_at).timestamp() > 120)
        mood = "sleeping" if stale else self.mood
        return {"kolobok_mood": mood, "speech_bubble": self.last_message, "source_status": self.source_status,
                "last_tick_at": self.last_tick_at, "symbol": settings.market_symbol,
                "signal": self.last_signal, "market": {k: v for k, v in payload.items() if k != "candles_m1"},
                "worker_uptime_note": "Worker работает внутри backend-процесса; Docker restart policy обеспечивает перезапуск контейнера."}

    def report_since(self, timestamp: str | None) -> str:
        if not timestamp:
            return "Пока нет предыдущего визита, по которому можно составить отчёт. Колобок начинает собирать историю с момента запуска."
        try:
            with self._connect() as db:
                rows = db.execute("SELECT timestamp,kind,summary FROM events WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 500", (timestamp,)).fetchall()
            if not rows:
                return "Пока значимых событий не записано. Это не означает, что рынок не двигался: поток мог быть недоступен."
            counts: dict[str, int] = {}
            for row in rows:
                counts[row["kind"]] = counts.get(row["kind"], 0) + 1
            lines = [f"Пока тебя не было, записано событий: {len(rows)}."]
            for row in rows[-8:]:
                stamp = row["timestamp"].replace("T", " ")[:16]
                lines.append(f"• {stamp} UTC — {row['summary']}")
            if counts.get("signal"):
                lines.append(f"За период сформировано потенциальных сигналов: {counts['signal']}. Они не являются исполненными сделками.")
            return "\n".join(lines)
        except sqlite3.Error as exc:
            log.exception("Could not build away report")
            return f"Не удалось прочитать архив событий: {type(exc).__name__}. Текущая работа worker продолжается."


async def main() -> None:
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    worker = KolobokWorker()
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
