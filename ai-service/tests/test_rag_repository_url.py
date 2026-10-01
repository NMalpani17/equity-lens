"""Tests for DATABASE_URL normalization (no database needed)."""

from app.services.rag.repository import to_libpq_url


def test_strips_prisma_only_params_and_keeps_the_rest() -> None:
    url = (
        "postgresql://user:p%40ss@host.example:6543/postgres"
        "?pgbouncer=true&sslmode=require&connection_limit=1"
    )

    assert to_libpq_url(url) == (
        "postgresql://user:p%40ss@host.example:6543/postgres?sslmode=require"
    )


def test_url_without_query_is_unchanged() -> None:
    url = "postgresql://user:pass@localhost:5432/db"

    assert to_libpq_url(url) == url
