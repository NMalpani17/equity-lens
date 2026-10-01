"""Tests for RAG component wiring."""

import pytest

from app.config import Settings
from app.services.rag.container import build_components
from app.services.rag.errors import RagNotConfiguredError


def test_build_components_requires_keys_and_database() -> None:
    settings = Settings(_env_file=None, database_url="", pinecone_api_key="pc")

    with pytest.raises(RagNotConfiguredError) as exc_info:
        build_components(settings)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["missing"] == [
        "DATABASE_URL",
        "AI_SERVICE_EQUIBLES_API_KEY",
        "AI_SERVICE_GEMINI_API_KEY",
    ]
