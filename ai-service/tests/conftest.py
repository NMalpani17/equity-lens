"""Shared fixtures."""

from collections.abc import Iterator

import pytest

from app.config import get_settings

TEST_INTERNAL_TOKEN = "test-internal-token"
INTERNAL_HEADERS = {"X-Internal-Token": TEST_INTERNAL_TOKEN}


@pytest.fixture(autouse=True)
def internal_token(monkeypatch) -> Iterator[str]:
    """Pin the internal token so tests never depend on a local .env."""
    monkeypatch.setattr(get_settings(), "internal_token", TEST_INTERNAL_TOKEN)
    yield TEST_INTERNAL_TOKEN
