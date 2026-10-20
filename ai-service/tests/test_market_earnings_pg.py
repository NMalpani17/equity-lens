"""Earnings calendar SQL against a real Postgres (skipped without one).

Set AI_SERVICE_TEST_DATABASE_URL to a throwaway database (never production):
the tests apply the market tracking migration into a fresh schema and drop it
afterwards.
"""

import os
import uuid
from collections.abc import Iterator
from datetime import date, datetime, timedelta
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
TODAY = date(2026, 10, 19)
END = TODAY + timedelta(days=60)


@pytest.fixture
def repos() -> Iterator[tuple]:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.market_data.earnings import EarningsRepository
    from app.services.market_data.refresh import RefreshStateRepository
    from app.services.rag.repository import create_pool

    schema = f"earnings_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        conn.execute(MIGRATION.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=4
    )
    try:
        yield RefreshStateRepository(pool), EarningsRepository(pool)
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


def row(ticker: str, day: date, hour=None, eps=None, revenue=None):
    from app.services.market_data.earnings import EarningsRow

    return EarningsRow(ticker, day, hour, eps, revenue, 2026, 3)


def load(repos, rows, now=T0) -> bool:
    from app.services.market_data.refresh import EARNINGS_CALENDAR

    states, earnings = repos
    lease = states.claim(EARNINGS_CALENDAR, policy(), now=now)
    assert lease is not None
    return earnings.replace_all(rows, start=TODAY, end=END, refresh_id=lease, now=now)


def test_next_per_ticker_within_the_window(repos) -> None:
    _, earnings = repos
    assert load(
        repos,
        [
            row("AMD", date(2026, 11, 3), "amc", 1.9664, 13215462917.0),
            row("AMD", date(2026, 12, 15)),
            row("NVDA", date(2026, 11, 17), "amc", 2.5259),
            row("JPM", date(2026, 10, 14), "bmo"),
            row("JPM", date(2027, 1, 13), "bmo"),
        ],
    )

    found = {
        r.ticker: r
        for r in earnings.next_per_ticker(["AMD", "NVDA", "JPM", "VOO"], TODAY, END)
    }

    assert set(found) == {"AMD", "NVDA"}
    assert found["AMD"].date == date(2026, 11, 3)
    assert found["AMD"].hour == "amc"
    assert found["AMD"].eps_estimate == pytest.approx(1.9664)
    assert found["AMD"].revenue_estimate == pytest.approx(13215462917.0)
    assert found["NVDA"].revenue_estimate is None


def test_a_refresh_replaces_the_whole_calendar(repos) -> None:
    from app.services.market_data.refresh import EARNINGS_CALENDAR

    states, earnings = repos
    load(repos, [row("AMD", date(2026, 11, 3)), row("OLD", date(2026, 11, 4))])
    load(repos, [row("AMD", date(2026, 11, 4))], now=T0 + timedelta(hours=25))

    found = earnings.next_per_ticker(["AMD", "OLD"], TODAY, END)

    assert [(r.ticker, r.date) for r in found] == [("AMD", date(2026, 11, 4))]
    state = states.get(EARNINGS_CALENDAR)
    assert (state.covered_from, state.covered_to, state.row_count) == (TODAY, END, 1)


def test_an_empty_calendar_is_stored(repos) -> None:
    from app.services.market_data.refresh import EARNINGS_CALENDAR

    states, earnings = repos
    assert load(repos, [])

    assert earnings.next_per_ticker(["AMD"], TODAY, END) == []
    assert states.get(EARNINGS_CALENDAR).refreshed_at == T0


def test_a_lost_lease_writes_nothing(repos) -> None:
    from app.services.market_data.refresh import EARNINGS_CALENDAR

    states, earnings = repos
    stale = states.claim(EARNINGS_CALENDAR, policy(), now=T0)
    assert states.claim(EARNINGS_CALENDAR, policy(), now=T0 + timedelta(minutes=31))

    written = earnings.replace_all(
        [row("AMD", date(2026, 11, 3))], start=TODAY, end=END, refresh_id=stale, now=T0
    )

    assert written is False
    assert earnings.next_per_ticker(["AMD"], TODAY, END) == []
