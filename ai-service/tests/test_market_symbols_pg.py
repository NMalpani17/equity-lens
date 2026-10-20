"""Symbol list and refresh lease SQL against a real Postgres (skipped without one).

Set AI_SERVICE_TEST_DATABASE_URL to a throwaway database (never production):
the tests apply the market tracking migration into a fresh schema and drop it
afterwards. pg_trgm is installed once per database, in "extensions".
"""

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api/prisma/migrations"
MIGRATION = (
    MIGRATIONS_DIR / "20261019000000_add_market_symbols_and_earnings/migration.sql"
)
T0 = datetime(2026, 10, 19, 15, 0)


@dataclass
class Db:
    pool: object
    states: object
    symbols: object


@pytest.fixture
def db() -> Iterator[Db]:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.market_data.refresh import RefreshStateRepository
    from app.services.market_data.symbols import SymbolRepository
    from app.services.rag.repository import create_pool

    schema = f"symbols_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        conn.execute(MIGRATION.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=6
    )
    try:
        yield Db(pool, RefreshStateRepository(pool), SymbolRepository(pool))
    finally:
        pool.close()
        with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def policy():
    from app.services.market_data.refresh import RefreshPolicy

    return RefreshPolicy(
        max_age=timedelta(hours=24),
        retry_after=timedelta(minutes=30),
        stale_after=timedelta(minutes=10),
    )


def rows(*tickers: str):
    from app.services.market_data.symbols import parse_symbol_list

    return parse_symbol_list(
        [
            {"symbol": t, "description": f"{t} CORP", "type": "Common Stock"}
            for t in tickers
        ]
    )


def stored(db: Db) -> list[str]:
    with db.pool.connection() as conn:
        return [
            r["ticker"]
            for r in conn.execute("SELECT ticker FROM market_symbols ORDER BY ticker")
        ]


def test_only_one_concurrent_claim_wins(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    with ThreadPoolExecutor(6) as pool:
        claims = list(
            pool.map(lambda _: db.states.claim(US_SYMBOLS, policy(), now=T0), range(6))
        )

    assert sum(c is not None for c in claims) == 1


def test_a_fresh_list_is_not_claimed_and_a_stale_lease_is(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    assert first is not None
    # Still running (inside the stale window): nobody else may start.
    assert db.states.claim(US_SYMBOLS, policy(), now=T0 + timedelta(minutes=5)) is None
    # The holder died; after the stale window and the failure backoff it's free.
    later = T0 + timedelta(minutes=31)
    second = db.states.claim(US_SYMBOLS, policy(), now=later)
    assert second not in (None, first)

    assert db.symbols.replace_all(rows("MSFT"), refresh_id=second, now=later)
    state = db.states.get(US_SYMBOLS)
    assert state.refreshed_at == later and state.refreshing_since is None
    assert state.row_count == 1
    # Fresh for a day.
    assert (
        db.states.claim(US_SYMBOLS, policy(), now=later + timedelta(hours=23)) is None
    )
    assert db.states.claim(US_SYMBOLS, policy(), now=later + timedelta(hours=25))


def test_a_failed_attempt_backs_off_and_keeps_the_list(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    db.symbols.replace_all(rows("AAPL", "MSFT"), refresh_id=first, now=T0)

    day_later = T0 + timedelta(hours=25)
    failing = db.states.claim(US_SYMBOLS, policy(), now=day_later)
    db.states.fail(US_SYMBOLS, failing, "finnhub server error: 503")

    state = db.states.get(US_SYMBOLS)
    assert state.last_error == "finnhub server error: 503"
    assert state.refreshing_since is None
    assert stored(db) == ["AAPL", "MSFT"]
    assert (
        db.states.claim(US_SYMBOLS, policy(), now=day_later + timedelta(minutes=10))
        is None
    )
    assert db.states.claim(US_SYMBOLS, policy(), now=day_later + timedelta(minutes=31))


def test_replace_swaps_the_whole_list(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    db.symbols.replace_all(rows("AAPL", "GONE", "MSFT"), refresh_id=first, now=T0)
    later = T0 + timedelta(days=2)
    second = db.states.claim(US_SYMBOLS, policy(), now=later)

    assert db.symbols.replace_all(
        rows("AAPL", "MSFT", "NEW"), refresh_id=second, now=later
    )
    assert stored(db) == ["AAPL", "MSFT", "NEW"]
    assert db.symbols.count() == 3


def test_a_lost_lease_writes_nothing(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    taken_over = db.states.claim(US_SYMBOLS, policy(), now=T0 + timedelta(minutes=31))
    assert taken_over is not None

    assert db.symbols.replace_all(rows("AAPL"), refresh_id=first, now=T0) is False
    assert stored(db) == []
    assert db.states.get(US_SYMBOLS).refreshing_since is not None
