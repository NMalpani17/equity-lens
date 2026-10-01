"""Integration tests for RagRepository against a real Postgres.

Skipped unless AI_SERVICE_TEST_DATABASE_URL points at a database (use a
*direct* connection, not the transaction pooler). Each run applies the Prisma
migration into a throwaway schema and drops it afterwards.
"""

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "api/prisma/migrations/20261002000000_add_rag_tables/migration.sql"
)
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
        conn.execute(MIGRATION.read_text())
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
