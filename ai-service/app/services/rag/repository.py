"""Postgres persistence for RAG state (Supabase, via psycopg).

The tables are owned by Prisma (``api/prisma/schema.prisma``); this module
only reads and writes them. Timestamps are naive UTC, matching Prisma's
``TIMESTAMP(3)`` convention.

Concurrency: :meth:`RagRepository.claim_ingestion` serializes claims for the
same ticker with a transaction-scoped advisory lock, so concurrent searches
(even across processes) start at most one job per ticker.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from psycopg import Connection, sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)


def utcnow() -> datetime:
    """Current time as naive UTC (what Prisma stores in TIMESTAMP(3))."""
    return datetime.now(UTC).replace(tzinfo=None)


def next_utc_midnight(now: datetime | None = None) -> datetime:
    """When the daily cap (and Equibles' quota) resets, as aware UTC."""
    now = now or datetime.now(UTC)
    return datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC)


class ClaimOutcome(StrEnum):
    STARTED = "started"
    ALREADY_INDEXING = "already_indexing"
    ALREADY_INDEXED = "already_indexed"
    UNAVAILABLE = "unavailable"
    CAP_REACHED = "cap_reached"
    NOT_INDEXED = "not_indexed"


class DailyCounter(StrEnum):
    """Columns of ``rag_daily_usage``; each has its own daily cap."""

    NEW_TICKER = "new_ticker_ingestions"
    REFRESH = "refresh_ingestions"


@dataclass(frozen=True)
class Claim:
    outcome: ClaimOutcome
    job_id: str | None = None


@dataclass(frozen=True)
class CachedTranscript:
    fiscal_year: int
    fiscal_quarter: int
    payload: dict[str, Any]


@dataclass(frozen=True)
class JobRecord:
    id: str
    ticker: str
    status: str
    trigger: str
    chunk_count: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True)
class TickerRecord:
    ticker: str
    status: str
    company_name: str | None
    chunk_count: int
    quarters: list[str] = field(default_factory=list)
    last_error: str | None = None
    last_job_id: str | None = None
    indexed_at: datetime | None = None
    latest_call_date: date | None = None
    freshness_checked_at: datetime | None = None


# Query parameters Prisma understands but libpq rejects ("invalid URI query
# parameter"), so the same DATABASE_URL works for both services.
_PRISMA_ONLY_PARAMS = frozenset(
    {"pgbouncer", "connection_limit", "pool_timeout", "schema", "statement_cache_size"}
)


def to_libpq_url(database_url: str) -> str:
    """Drop Prisma-only query parameters from a Postgres URL."""
    parts = urlsplit(database_url)
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key not in _PRISMA_ONLY_PARAMS
    ]
    return urlunsplit(parts._replace(query=urlencode(query)))


# Idle connections are closed after this long (the pooler drops idle
# connections on its own, and a dropped one fails the next query).
POOL_MAX_IDLE_SECONDS = 300


def create_pool(database_url: str, max_size: int) -> ConnectionPool:
    """Open a connection pool.

    ``prepare_threshold=None`` disables server-side prepared statements, which
    Supabase's transaction-mode pooler (PgBouncer/Supavisor) does not support.
    ``check`` tests each connection as it is handed out, so one the pooler
    closed while idle is replaced instead of failing the first query after a
    quiet period.
    """
    return ConnectionPool(
        to_libpq_url(database_url),
        min_size=1,
        max_size=max_size,
        kwargs={"prepare_threshold": None, "row_factory": dict_row},
        check=ConnectionPool.check_connection,
        max_idle=POOL_MAX_IDLE_SECONDS,
        open=True,
        timeout=10,
    )


_TICKER_COLUMNS = """
    ticker, status::text AS status, company_name, chunk_count, quarters,
    last_error, last_job_id::text AS last_job_id, indexed_at, latest_call_date,
    freshness_checked_at
"""

_JOB_COLUMNS = """
    id::text AS id, ticker, status::text AS status, trigger, chunk_count, error,
    created_at, started_at, finished_at
"""


class RagRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    # --- Transcript cache -------------------------------------------------

    def get_cached_transcripts(self, ticker: str) -> list[CachedTranscript]:
        """Cached raw transcripts for a ticker, newest fiscal period first."""
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT fiscal_year, fiscal_quarter, payload FROM rag_transcripts
                WHERE ticker = %s
                ORDER BY fiscal_year DESC, fiscal_quarter DESC
                """,
                (ticker,),
            ).fetchall()
        return [CachedTranscript(**row) for row in rows]

    def save_transcript(
        self,
        ticker: str,
        fiscal_year: int,
        fiscal_quarter: int,
        payload: dict[str, Any],
        *,
        event_title: str | None,
        call_date: datetime | None,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO rag_transcripts
                    (ticker, fiscal_year, fiscal_quarter, event_title, call_date,
                     payload, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker, fiscal_year, fiscal_quarter) DO UPDATE SET
                    event_title = EXCLUDED.event_title,
                    call_date = EXCLUDED.call_date,
                    payload = EXCLUDED.payload,
                    fetched_at = EXCLUDED.fetched_at
                """,
                (
                    ticker,
                    fiscal_year,
                    fiscal_quarter,
                    event_title,
                    call_date.astimezone(UTC).replace(tzinfo=None)
                    if call_date and call_date.tzinfo
                    else call_date,
                    Jsonb(payload),
                    utcnow(),
                ),
            )

    # --- Tickers and jobs -------------------------------------------------

    def get_ticker(self, ticker: str) -> TickerRecord | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {_TICKER_COLUMNS} FROM rag_tickers WHERE ticker = %s",
                (ticker,),
            ).fetchone()
        return TickerRecord(**row) if row else None

    def list_tickers(self) -> list[TickerRecord]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT {_TICKER_COLUMNS} FROM rag_tickers ORDER BY ticker"
            ).fetchall()
        return [TickerRecord(**row) for row in rows]

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {_JOB_COLUMNS} FROM rag_ingestion_jobs WHERE id = %s",
                (job_id,),
            ).fetchone()
        return JobRecord(**row) if row else None

    def claim_ingestion(
        self,
        ticker: str,
        *,
        trigger: str,
        daily_cap: int | None,
        stale_after: timedelta,
        force: bool = False,
        refresh: bool = False,
        today: date | None = None,
    ) -> Claim:
        """Atomically decide whether to start an ingestion job for ``ticker``.

        ``daily_cap=None`` bypasses the cap (seed script). ``force`` re-ingests
        tickers that are already indexed or marked unavailable. ``refresh``
        claims an *indexed* ticker to add a newer call and charges the refresh
        counter instead of the new-ticker one (NOT_INDEXED for any other
        ticker).
        """
        today = today or datetime.now(UTC).date()
        now = utcnow()
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))", (f"rag_ingest:{ticker}",)
            )
            row = conn.execute(
                """
                SELECT t.status::text AS status, t.last_job_id::text AS job_id,
                       j.created_at AS job_created_at
                FROM rag_tickers t
                LEFT JOIN rag_ingestion_jobs j ON j.id = t.last_job_id
                WHERE t.ticker = %s
                """,
                (ticker,),
            ).fetchone()

            if row is not None:
                status = row["status"]
                if status == "indexing":
                    created = row["job_created_at"]
                    if created is not None and now - created < stale_after:
                        return Claim(ClaimOutcome.ALREADY_INDEXING, row["job_id"])
                    self._expire_job(conn, row["job_id"], now)
                elif refresh and status != "indexed":
                    return Claim(ClaimOutcome.NOT_INDEXED)
                elif status == "indexed" and not (force or refresh):
                    return Claim(ClaimOutcome.ALREADY_INDEXED)
                elif status == "unavailable" and not force:
                    return Claim(ClaimOutcome.UNAVAILABLE)
            elif refresh:
                return Claim(ClaimOutcome.NOT_INDEXED)

            counter = DailyCounter.REFRESH if refresh else DailyCounter.NEW_TICKER
            if daily_cap is not None and not self._consume_daily_slot(
                conn, today, daily_cap, now, counter
            ):
                return Claim(ClaimOutcome.CAP_REACHED)

            job_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO rag_ingestion_jobs (id, ticker, status, trigger, created_at)
                VALUES (%s, %s, 'queued', %s, %s)
                """,
                (job_id, ticker, trigger, now),
            )
            conn.execute(
                """
                INSERT INTO rag_tickers
                    (ticker, status, last_job_id, created_at, updated_at)
                VALUES (%s, 'indexing', %s, %s, %s)
                ON CONFLICT (ticker) DO UPDATE SET
                    status = 'indexing',
                    last_job_id = EXCLUDED.last_job_id,
                    last_error = NULL,
                    updated_at = EXCLUDED.updated_at
                """,
                (ticker, job_id, now, now),
            )
            return Claim(ClaimOutcome.STARTED, job_id)

    def claim_freshness_check(
        self, ticker: str, *, now: datetime | None = None
    ) -> bool:
        """Record today's freshness check for ``ticker``; False if already done.

        One UPDATE decides it, so concurrent searches (even across processes)
        check a ticker at most once per UTC day. Only tickers that have been
        indexed qualify.
        """
        now = now or utcnow()
        day_start = datetime.combine(now.date(), datetime.min.time())
        with self._pool.connection() as conn:
            row = conn.execute(
                """
                UPDATE rag_tickers SET freshness_checked_at = %s
                WHERE ticker = %s AND indexed_at IS NOT NULL
                  AND status IN ('indexed', 'indexing')
                  AND (freshness_checked_at IS NULL OR freshness_checked_at < %s)
                RETURNING ticker
                """,
                (now, ticker, day_start),
            ).fetchone()
        return row is not None

    def get_daily_usage(
        self, day: date, counter: DailyCounter = DailyCounter.NEW_TICKER
    ) -> int:
        query = sql.SQL("SELECT {} AS used FROM rag_daily_usage WHERE day = %s")
        with self._pool.connection() as conn:
            row = conn.execute(
                query.format(sql.Identifier(counter.value)), (day,)
            ).fetchone()
        return int(row["used"]) if row else 0

    def mark_job_running(self, job_id: str) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                UPDATE rag_ingestion_jobs SET status = 'running', started_at = %s
                WHERE id = %s
                """,
                (utcnow(), job_id),
            )

    def complete_job(
        self,
        job_id: str,
        ticker: str,
        *,
        company_name: str,
        chunk_count: int,
        quarters: list[str],
        latest_call_date: date | None = None,
    ) -> None:
        now = utcnow()
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """
                UPDATE rag_ingestion_jobs
                SET status = 'succeeded', chunk_count = %s, finished_at = %s
                WHERE id = %s
                """,
                (chunk_count, now, job_id),
            )
            conn.execute(
                """
                UPDATE rag_tickers SET status = 'indexed', company_name = %s,
                    chunk_count = %s, quarters = %s, last_error = NULL,
                    latest_call_date = COALESCE(%s, latest_call_date),
                    indexed_at = %s, updated_at = %s
                WHERE ticker = %s
                """,
                (
                    company_name,
                    chunk_count,
                    Jsonb(quarters),
                    latest_call_date,
                    now,
                    now,
                    ticker,
                ),
            )

    def fail_job(
        self,
        job_id: str,
        ticker: str,
        *,
        error: str,
        unavailable: bool,
        keep_indexed: bool = False,
    ) -> None:
        """Record a failed job. ``keep_indexed`` (a failed refresh) leaves the
        ticker ``indexed``: its existing vectors are intact and searchable."""
        now = utcnow()
        if keep_indexed:
            status = "indexed"
        else:
            status = "unavailable" if unavailable else "failed"
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """
                UPDATE rag_ingestion_jobs
                SET status = 'failed', error = %s, finished_at = %s
                WHERE id = %s
                """,
                (error, now, job_id),
            )
            # Only touch the ticker if this is still its current job.
            conn.execute(
                """
                UPDATE rag_tickers
                SET status = %s::rag_ticker_status, last_error = %s, updated_at = %s
                WHERE ticker = %s AND last_job_id = %s
                """,
                (status, error, now, ticker, job_id),
            )

    # --- Internals --------------------------------------------------------

    @staticmethod
    def _consume_daily_slot(
        conn: Connection,
        today: date,
        cap: int,
        now: datetime,
        counter: DailyCounter = DailyCounter.NEW_TICKER,
    ) -> bool:
        """Increment today's ``counter`` if below ``cap``. False at the cap."""
        conn.execute(
            """
            INSERT INTO rag_daily_usage (day, updated_at)
            VALUES (%s, %s) ON CONFLICT (day) DO NOTHING
            """,
            (today, now),
        )
        update = sql.SQL(
            """
            UPDATE rag_daily_usage SET {column} = {column} + 1, updated_at = %s
            WHERE day = %s AND {column} < %s
            RETURNING {column}
            """
        ).format(column=sql.Identifier(counter.value))
        row = conn.execute(update, (now, today, cap)).fetchone()
        return row is not None

    @staticmethod
    def _expire_job(conn: Connection, job_id: str | None, now: datetime) -> None:
        if job_id is None:
            return
        logger.warning("expiring stale ingestion job %s", job_id)
        conn.execute(
            """
            UPDATE rag_ingestion_jobs
            SET status = 'failed', error = 'stale: worker did not finish',
                finished_at = %s
            WHERE id = %s AND status IN ('queued', 'running')
            """,
            (now, job_id),
        )
