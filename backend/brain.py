"""LLM commentary with bounded caching and a deterministic safe fallback."""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict
from typing import Any

import httpx

from config import settings

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """Ты — мудрый, спокойный трейдер-наставник по имени Колобок. Объясняй рынок простым русским языком, без драматизации и обещаний прибыли. Используй только предоставленные данные. Не выдумывай действия крупных игроков и не утверждай, что знаешь намерения участников. Если сигнал отсутствует — дай 1–2 предложения наблюдения. Если сигнал есть — объясни конкретные подтверждения и риски. Всегда укажи, если объём является tick-volume proxy, а не централизованным биржевым объёмом. Не обещай доходность и не представляй сигнал как гарантированную сделку."""


class KolobokBrain:
    def __init__(self) -> None:
        self._cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._max_cache_entries = 256
        self._client = httpx.AsyncClient(timeout=settings.llm_timeout_seconds)

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _key(payload: dict[str, Any], mode: str) -> str:
        raw = json.dumps({"mode": mode, "payload": payload}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _cache_get(self, key: str) -> str | None:
        item = self._cache.get(key)
        if not item:
            return None
        created, value = item
        if time.monotonic() - created > settings.llm_cache_ttl_seconds:
            self._cache.pop(key, None)
            return None
        self._cache.move_to_end(key)
        return value

    def _cache_set(self, key: str, value: str) -> None:
        self._cache[key] = (time.monotonic(), value)
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_cache_entries:
            self._cache.popitem(last=False)

    async def commentary(self, payload: dict[str, Any], *, observation: bool = False) -> str:
        """Return a cached LLM comment or a local fallback if no LLM key is set."""
        key = self._key(payload, "observation" if observation else "update")
        cached = self._cache_get(key)
        if cached:
            return cached

        if not settings.llm_api_key:
            result = self._fallback(payload, observation=observation)
            self._cache_set(key, result)
            return result

        base = settings.llm_base_url.rstrip("/")
        url = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
        prompt = (
            "Сделай короткое наблюдение за рынком. Это плановая пятиминутная заметка; даже если рынок спокоен, объясни, что именно наблюдаем."
            if observation else
            "Обнови комментарий Колобка по текущему состоянию рынка. Ответ 1–3 предложения."
        )
        body = {
            "model": settings.llm_model,
            "temperature": 0.2,
            "max_tokens": 180,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt + "\nДанные JSON:\n" + json.dumps(payload, ensure_ascii=False)},
            ],
        }
        try:
            response = await self._client.post(url, headers={"Authorization": f"Bearer {settings.llm_api_key}"}, json=body)
            response.raise_for_status()
            data = response.json()
            result = data["choices"][0]["message"]["content"].strip()
            if not result:
                raise ValueError("LLM returned an empty message")
            self._cache_set(key, result)
            return result
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            log.warning("LLM unavailable; using local commentary: %s", exc)
            result = self._fallback(payload, observation=observation)
            self._cache_set(key, result)
            return result

    @staticmethod
    def _fallback(payload: dict[str, Any], *, observation: bool) -> str:
        price = payload.get("price")
        trend = payload.get("h1_trend", "не определён")
        signal = payload.get("signal") or {}
        pattern = payload.get("pattern", "нет подтверждённого паттерна")
        volume = payload.get("volume", {})
        volume_text = "объём тиков повышен" if volume.get("spike") else "всплеск tick-volume не подтверждён"
        level = payload.get("levels", {})
        support, resistance = level.get("support"), level.get("resistance")
        price_text = f"Цена около {price:.5f}" if isinstance(price, (float, int)) else "Новая цена ещё не получена"
        if signal.get("status") in ("BUY", "SELL"):
            side = "покупку" if signal["status"] == "BUY" else "продажу"
            return f"Вижу потенциальный сигнал на {side}: {signal.get('reason', pattern)}. {price_text}; тренд H1 — {trend}. Проверьте стоп-лосс и риск до любого решения."
        if observation:
            if volume.get("spike"):
                return f"Пятиминутное наблюдение: {price_text}; {volume_text}, тренд H1 — {trend}. Уровни для наблюдения: поддержка {support or 'не определена'}, сопротивление {resistance or 'не определено'}. Ждём подтверждения, не торопимся."
            return f"Пятиминутное наблюдение: {price_text}; рынок пока без подтверждённого сигнала, {volume_text}. Тренд H1 — {trend}; сохраняем терпение и ждём выхода из диапазона."
        return f"{price_text}. Тренд H1 — {trend}; {volume_text}. {pattern.capitalize()}. Поддержка {support or 'не определена'}, сопротивление {resistance or 'не определено'} — жду подтверждения, а не угадываю движение."
