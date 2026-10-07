"""Report repository SQL against a real Postgres (skipped without one).

Set AI_SERVICE_TEST_DATABASE_URL to a throwaway database (never production):
the tests apply the research_reports migration into a fresh schema and drop
it afterwards.
"""

import os
import threading
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api/prisma/migrations"
MIGRATION = MIGRATIONS_DIR / "20261008000000_add_research_reports/migration.sql"
# The migration also alters chat_usage_events; its own migration backfills
# from chat_messages, so a minimal table stands in for it.
CHAT_USAGE_EVENTS = """
CREATE TABLE "chat_usage_events" (
    "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL, "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""
STALE = timedelta(minutes=10)
WEEK = timedelta(days=7)
T0 = datetime(2026, 10, 7, 12, 0)


@pytest.fixture
def repo() -> Iterator:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.rag.repository import create_pool
    from app.services.report.repository import ReportRepository

    schema = f"report_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        conn.execute(CHAT_USAGE_EVENTS)
        conn.execute(MIGRATION.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=10
    )
    try:
        yield ReportRepository(pool)
    finally:
        pool.close()
        with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def claim(repo, *, now=T0, regenerate_after=WEEK):
    return repo.claim(
        "NVDA", 2027, 2, regenerate_after=regenerate_after, stale_after=STALE, now=now
    )


def test_claim_save_then_fresh_until_the_window_passes(repo) -> None:
    from app.services.report.repository import ClaimOutcome

    first = claim(repo)
    assert first.outcome is ClaimOutcome.CLAIMED
    assert claim(repo).outcome is ClaimOutcome.IN_PROGRESS

    saved_at = repo.save(
        first.generation_id,
        content={"version": 1},
        company_name="Nvidia Corp",
        trace_id="t1",
        now=T0,
    )
    assert saved_at == T0
    stored = repo.get("NVDA", 2027, 2)
    assert stored.content == {"version": 1} and stored.trace_id == "t1"

    fresh = claim(repo, now=T0 + timedelta(days=6))
    assert fresh.outcome is ClaimOutcome.FRESH and fresh.generated_at == T0
    # Older than the window, or with a zero window: a new generation may run.
    assert claim(repo, now=T0 + timedelta(days=8)).outcome is ClaimOutcome.CLAIMED


def test_regenerate_window_zero_always_claims(repo) -> None:
    from app.services.report.repository import ClaimOutcome

    first = claim(repo)
    repo.save(first.generation_id, content={}, company_name="N", trace_id=None, now=T0)

    again = claim(repo, now=T0 + timedelta(minutes=1), regenerate_after=timedelta(0))
    assert again.outcome is ClaimOutcome.CLAIMED


def test_release_frees_the_report_and_a_stale_claim_is_taken_over(repo) -> None:
    from app.services.report.repository import ClaimOutcome

    first = claim(repo)
    repo.release(first.generation_id)
    second = claim(repo)
    assert second.outcome is ClaimOutcome.CLAIMED

    # A crashed generation's claim expires after the stale window...
    third = claim(repo, now=T0 + STALE + timedelta(seconds=1))
    assert third.outcome is ClaimOutcome.CLAIMED
    # ...and the old one can no longer save over it.
    assert (
        repo.save(second.generation_id, content={}, company_name="N", trace_id=None)
        is None
    )
    assert repo.get("NVDA", 2027, 2).content is None


def test_concurrent_claims_have_exactly_one_winner(repo) -> None:
    from app.services.report.repository import ClaimOutcome

    outcomes: list = []
    barrier = threading.Barrier(8)

    def race() -> None:
        barrier.wait()
        outcomes.append(claim(repo).outcome)

    threads = [threading.Thread(target=race) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert outcomes.count(ClaimOutcome.CLAIMED) == 1
    assert outcomes.count(ClaimOutcome.IN_PROGRESS) == 7


def test_research_reports_has_row_level_security(repo) -> None:
    # The pool's search_path is the fixture's schema, so this is its table.
    with repo._pool.connection() as conn:
        row = conn.execute(
            "SELECT relrowsecurity FROM pg_class "
            "WHERE oid = 'research_reports'::regclass"
        ).fetchone()

    assert row["relrowsecurity"] is True
