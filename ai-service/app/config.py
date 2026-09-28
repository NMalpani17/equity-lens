"""Environment-based configuration.

All runtime config is read here via pydantic-settings. Nothing else in the
service should read ``os.environ`` directly.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings, loaded from environment / ``.env``."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="AI_SERVICE_",
        extra="ignore",
    )

    app_name: str = "equity-lens-ai-service"
    environment: str = "development"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"
    # Comma-separated list of allowed CORS origins (the API gateway).
    cors_origins: str = "http://localhost:3001"

    # --- Market data ---
    # Finnhub is the primary quote provider; yfinance is the automatic fallback.
    finnhub_api_key: str = ""
    finnhub_base_url: str = "https://finnhub.io/api/v1"
    # How long (seconds) a quote is served from cache before refetching.
    market_cache_ttl_seconds: int = 60
    # HTTP timeout (seconds) for outbound provider requests.
    market_http_timeout_seconds: float = 5.0

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS origins as a list."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
