"""The chat eval must never ingest, refresh or prune the production index."""

from app.config import Settings
from scripts.eval_chat import eval_settings


def test_eval_settings_turn_off_ingestion_refresh_and_the_rerank_cache() -> None:
    base = Settings(
        _env_file=None,
        rag_daily_ingestion_cap=8,
        rag_daily_refresh_cap=3,
        rag_query_cache_ttl_seconds=3600,
    )

    settings = eval_settings(base)

    assert settings.rag_daily_ingestion_cap == 0
    assert settings.rag_daily_refresh_cap == 0
    assert settings.rag_query_cache_ttl_seconds == 0
    # Everything else is the caller's configuration, untouched.
    assert settings.model_dump(
        exclude={
            "rag_daily_ingestion_cap",
            "rag_daily_refresh_cap",
            "rag_query_cache_ttl_seconds",
        }
    ) == base.model_dump(
        exclude={
            "rag_daily_ingestion_cap",
            "rag_daily_refresh_cap",
            "rag_query_cache_ttl_seconds",
        }
    )
