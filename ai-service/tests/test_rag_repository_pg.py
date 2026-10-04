"""Integration tests for RagRepository against a real Postgres.

Skipped unless AI_SERVICE_TEST_DATABASE_URL points at a database (use a
*direct* connection, not the transaction pooler). Each run applies the Prisma
RAG migrations into a throwaway schema and drops it afterwards.
"""

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api/prisma/migrations"
MIGRATIONS = [
    MIGRATIONS_DIR / name / "migration.sql"
    for name in ("20261002000000_add_rag_tables", "20261006000000_add_rag_freshness")
]
STALE = timedelta(minutes=30)


@pytest.fixture
def repo() -> Iterator:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.rag.repository import RagRepository, create_pool

    schema = f"rag_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        for migration in MIGRATIONS:
            conn.execute(migration.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=10
    )
    try:
        yield RagRepository(pool)
    finally:
        pool.close()
        with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def test_claim_lifecycle(repo) -> None:
    from app.services.rag.repository import ClaimOutcome

    claim = repo.claim_ingestion(
        "AAPL", trigger="seed", daily_cap=None, stale_after=STALE
    )
    assert claim.outcome is ClaimOutcome.STARTED
    assert repo.get_ticker("AAPL").status == "indexing"

    repo.mark_job_running(claim.job_id)
    repo.complete_job(
        claim.job_id,
        "AAPL",
        company_name="Apple Inc",
        chunk_count=10,
        quarters=["FY2025Q4"],
    )

    ticker = repo.get_ticker("AAPL")
    assert ticker.status == "indexed" and ticker.quarters == ["FY2025Q4"]
    assert repo.get_job(claim.job_id).status == "succeeded"
    again = repo.claim_ingestion(
        "AAPL", trigger="seed", daily_cap=None, stale_after=STALE
    )
    assert again.outcome is ClaimOutcome.ALREADY_INDEXED


def test_concurrent_claims_start_exactly_one_job(repo) -> None:
    from app.services.rag.repository import ClaimOutcome

    def claim(_: int):
        return repo.claim_ingestion(
            "NVDA", trigger="on_demand", daily_cap=8, stale_after=STALE
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = [c.outcome for c in pool.map(claim, range(8))]

    assert outcomes.count(ClaimOutcome.STARTED) == 1
    assert outcomes.count(ClaimOutcome.ALREADY_INDEXING) == 7
    assert repo.get_daily_usage(date.today()) <= 1


def test_daily_cap_is_enforced(repo) -> None:
    from app.services.rag.repository import ClaimOutcome

    today = date(2026, 1, 1)
    outcomes = [
        repo.claim_ingestion(
            f"T{i}", trigger="on_demand", daily_cap=2, stale_after=STALE, today=today
        ).outcome
        for i in range(3)
    ]

    assert outcomes == [
        ClaimOutcome.STARTED,
        ClaimOutcome.STARTED,
        ClaimOutcome.CAP_REACHED,
    ]
    assert repo.get_daily_usage(today) == 2


def test_failed_job_marks_unavailable_and_transcripts_round_trip(repo) -> None:
    from app.services.rag.repository import ClaimOutcome

    claim = repo.claim_ingestion(
        "ZZZZ", trigger="seed", daily_cap=None, stale_after=STALE
    )
    repo.fail_job(claim.job_id, "ZZZZ", error="none", unavailable=True)
    assert (
        repo.claim_ingestion(
            "ZZZZ", trigger="seed", daily_cap=None, stale_after=STALE
        ).outcome
        is ClaimOutcome.UNAVAILABLE
    )

    repo.save_transcript(
        "AAPL", 2025, 3, {"data": [1]}, event_title="t", call_date=None
    )
    repo.save_transcript(
        "AAPL", 2025, 4, {"data": [2]}, event_title="t", call_date=None
    )
    cached = repo.get_cached_transcripts("AAPL")
    assert [(c.fiscal_year, c.fiscal_quarter) for c in cached] == [(2025, 4), (2025, 3)]
    assert cached[0].payload == {"data": [2]}


def index(repo, ticker: str, call_date: date | None = date(2025, 4, 15)) -> None:
    claim = repo.claim_ingestion(
        ticker, trigger="seed", daily_cap=None, stale_after=STALE
    )
    repo.complete_job(
        claim.job_id,
        ticker,
        company_name=f"{ticker} Inc",
        chunk_count=12,
        quarters=["FY2025Q4"],
        latest_call_date=call_date,
    )


def test_freshness_check_is_claimed_once_per_utc_day(repo) -> None:
    index(repo, "AAPL")
    now = datetime(2026, 3, 1, 9)

    with ThreadPoolExecutor(max_workers=8) as pool:
        wins = list(
            pool.map(lambda _: repo.claim_freshness_check("AAPL", now=now), range(8))
        )

    assert wins.count(True) == 1
    ticker = repo.get_ticker("AAPL")
    assert ticker.freshness_checked_at == now
    assert ticker.latest_call_date == date(2025, 4, 15)
    later_today = datetime(2026, 3, 1, 23)
    assert repo.claim_freshness_check("AAPL", now=later_today) is False
    assert repo.claim_freshness_check("AAPL", now=datetime(2026, 3, 2, 0, 5))
    assert repo.claim_freshness_check("NEVER", now=now) is False


def test_refresh_claims_use_their_own_daily_counter(repo) -> None:
    from app.services.rag.repository import ClaimOutcome, DailyCounter

    today = date(2026, 3, 1)
    for ticker in ("AAPL", "MSFT"):
        index(repo, ticker)

    first = repo.claim_ingestion(
        "AAPL",
        trigger="refresh",
        daily_cap=1,
        stale_after=STALE,
        refresh=True,
        today=today,
    )
    second = repo.claim_ingestion(
        "MSFT",
        trigger="refresh",
        daily_cap=1,
        stale_after=STALE,
        refresh=True,
        today=today,
    )
    missing = repo.claim_ingestion(
        "NVDA",
        trigger="refresh",
        daily_cap=1,
        stale_after=STALE,
        refresh=True,
        today=today,
    )

    assert first.outcome is ClaimOutcome.STARTED
    assert second.outcome is ClaimOutcome.CAP_REACHED
    assert missing.outcome is ClaimOutcome.NOT_INDEXED
    assert repo.get_daily_usage(today, DailyCounter.REFRESH) == 1
    assert repo.get_daily_usage(today) == 0  # the new-ticker cap is untouched
    assert repo.get_job(first.job_id).trigger == "refresh"


def test_failed_refresh_keeps_ticker_indexed(repo) -> None:
    from app.services.rag.repository import ClaimOutcome

    index(repo, "AAPL")
    claim = repo.claim_ingestion(
        "AAPL", trigger="refresh", daily_cap=3, stale_after=STALE, refresh=True
    )
    assert claim.outcome is ClaimOutcome.STARTED
    assert repo.get_ticker("AAPL").status == "indexing"

    repo.fail_job(
        claim.job_id, "AAPL", error="boom", unavailable=True, keep_indexed=True
    )

    ticker = repo.get_ticker("AAPL")
    assert (ticker.status, ticker.last_error) == ("indexed", "boom")
    assert ticker.indexed_at is not None


def test_migration_backfills_latest_call_date() -> None:
    import psycopg

    schema = f"rag_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        try:
            conn.execute(f'SET search_path TO "{schema}"')
            conn.execute(MIGRATIONS[0].read_text())
            conn.execute(
                "INSERT INTO rag_tickers (ticker, status) VALUES ('AAPL', 'indexed'),"
                " ('NEW', 'indexing')"
            )
            conn.execute(
                "INSERT INTO rag_transcripts (ticker, fiscal_year, fiscal_quarter,"
                " call_date, payload) VALUES"
                " ('AAPL', 2025, 3, '2025-01-30 21:00', '{}'),"
                " ('AAPL', 2025, 4, '2025-04-15 21:00', '{}')"
            )
            conn.execute(MIGRATIONS[1].read_text())
            rows = conn.execute(
                "SELECT ticker, latest_call_date FROM rag_tickers ORDER BY ticker"
            ).fetchall()
        finally:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')

    assert rows == [("AAPL", date(2025, 4, 15)), ("NEW", None)]
