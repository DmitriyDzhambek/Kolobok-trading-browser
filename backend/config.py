"""Configuration for Kolobok background market assistant.

All credentials are read from environment variables. Never commit real API keys.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Kolobok Market Brain"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"
    database_path: str = "./data/kolobok.sqlite3"

    # Twelve Data real-time quote stream. Forex has no centralized exchange volume;
    # worker uses tick count as a clearly-labelled tick-volume proxy.
    twelvedata_api_key: str = ""
    twelvedata_ws_url: str = "wss://ws.twelvedata.com/v1/quotes/price"
    market_symbol: str = "EUR/USD"
    market_poll_seconds: float = 1.0
    reconnect_max_seconds: float = 30.0

    # Any OpenAI-compatible chat-completions API, e.g. OpenAI or DeepSeek.
    llm_provider: str = "openai"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: float = 20.0
    llm_cache_ttl_seconds: int = 300
    observation_interval_seconds: int = 300

    away_report_after_seconds: int = 300
    cors_origins: str = "http://127.0.0.1:5500,http://localhost:5500,null"

    model_config = SettingsConfigDict(env_file=".env", env_prefix="KOLOBOK_", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
