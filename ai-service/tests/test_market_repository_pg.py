"""Market data cache SQL against a real Postgres (skipped without one).

Set AI_SERVICE_TEST_DATABASE_URL to a throwaway database (never production):
the tests apply the market data cache migration into a fresh schema and drop
it afterwards.
"""

import os
import uuid
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api/prisma/migrations"
MIGRATION = MIGRATIONS_DIR / "20261018000000_add_market_data_cache/migration.sql"
T0 = datetime(2026, 10, 16, 21, 0)


@pytest.fixture
def repo() -> Iterator:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.market_data.repository import MarketDataRepository
    from app.services.rag.repository import create_pool

    schema = f"market_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        conn.execute(MIGRATION.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=4
    )
    try:
        yield MarketDataRepository(pool)
    finally:
        pool.close()
        with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def test_save_append_and_replace_closes(repo) -> None:
    oct1, oct2, oct5 = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 5)
    repo.save_closes(
        "AAPL",
        [(oct1, 100.0), (oct2, 101.5)],
        covered_from=oct1,
        fetched_through=oct2,
        replace=True,
        now=T0,
    )
    repo.save_closes(
        "AAPL",
        [(oct2, 101.25), (oct5, 103.0)],
        covered_from=oct1,
        fetched_through=oct5,
        replace=False,
        now=T0,
    )

    assert repo.closes(["AAPL"], oct2) == {"AAPL": [(oct2, 101.25), (oct5, 103.0)]}
    coverage = repo.coverage(["AAPL", "MSFT"])
    assert list(coverage) == ["AAPL"]
    assert coverage["AAPL"].fetched_through == oct5
    assert coverage["AAPL"].status == "ok"

    repo.save_closes(
        "AAPL", [(oct5, 51.5)], covered_from=oct5, fetched_through=oct5, replace=True
    )
    assert repo.closes(["AAPL"], oct1) == {"AAPL": [(oct5, 51.5)]}


def test_save_and_update_profiles(repo) -> None:
    from app.services.market_data.repository import StoredProfile

    repo.save_profile(StoredProfile("VOO", None, None, None, "none", T0))
    repo.save_profile(
        StoredProfile("VOO", "Vanguard S&P 500 ETF", "Funds", "ETF", "yfinance", T0)
    )

    stored = repo.profiles(["VOO", "AAPL"])
    assert list(stored) == ["VOO"]
    assert stored["VOO"].sector == "Funds" and stored["VOO"].fetched_at == T0


def test_mark_no_history(repo) -> None:
    repo.mark_no_history(
        "ZZZZ", covered_from=date(2026, 10, 1), fetched_through=date(2026, 10, 16)
    )

    assert repo.coverage(["ZZZZ"])["ZZZZ"].status == "no_history"
    assert repo.closes(["ZZZZ"], date(2026, 1, 1)) == {}
