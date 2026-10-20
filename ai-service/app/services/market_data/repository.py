"""Postgres persistence for the market data cache (Supabase, via psycopg).

The tables are owned by Prisma (``api/prisma/schema.prisma``); this module only
reads and writes them. Timestamps are naive UTC, matching Prisma's
``TIMESTAMP(3)``. The cache is shared across users and holds no user data.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from psycopg_pool import ConnectionPool

from app.services.rag.repository import utcnow

logger = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_NO_HISTORY = "no_history"


@dataclass(frozen=True)
class Coverage:
    """What ``market_daily_closes`` holds for one ticker."""

    ticker: str
    covered_from: date
    fetched_through: date
    status: str
    fetched_at: datetime


@dataclass(frozen=True)
class StoredProfile:
    """A ``company_profiles`` row."""

    ticker: str
    name: str | None
    sector: str | None
    industry: str | None
    source: str
    fetched_at: datetime


class MarketDataRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def profiles(self, tickers: Sequence[str]) -> dict[str, StoredProfile]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT ticker, name, sector, industry, source, fetched_at
                FROM company_profiles
                WHERE ticker = ANY(%s)
                """,
                (list(tickers),),
            ).fetchall()
        return {row["ticker"]: StoredProfile(**row) for row in rows}

    def save_profile(self, profile: StoredProfile) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO company_profiles
                    (ticker, name, sector, industry, source, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker) DO UPDATE SET
                    name = EXCLUDED.name,
                    sector = EXCLUDED.sector,
                    industry = EXCLUDED.industry,
                    source = EXCLUDED.source,
                    fetched_at = EXCLUDED.fetched_at
                """,
                (
                    profile.ticker,
                    profile.name,
                    profile.sector,
                    profile.industry,
                    profile.source,
                    profile.fetched_at,
                ),
            )

    def coverage(self, tickers: Sequence[str]) -> dict[str, Coverage]:
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT ticker, covered_from, fetched_through, status, fetched_at
                FROM market_history_coverage
                WHERE ticker = ANY(%s)
                """,
                (list(tickers),),
            ).fetchall()
        return {row["ticker"]: Coverage(**row) for row in rows}

    def closes(
        self, tickers: Sequence[str], start: date
    ) -> dict[str, list[tuple[date, float]]]:
        """Cached closes on or after ``start``, oldest first, per ticker."""
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT ticker, date, close
                FROM market_daily_closes
                WHERE ticker = ANY(%s) AND date >= %s
                ORDER BY ticker, date
                """,
                (list(tickers), start),
            ).fetchall()
        series: dict[str, list[tuple[date, float]]] = {}
        for row in rows:
            series.setdefault(row["ticker"], []).append(
                (row["date"], float(row["close"]))
            )
        return series

    def save_closes(
        self,
        ticker: str,
        rows: Sequence[tuple[date, float]],
        *,
        covered_from: date,
        fetched_through: date,
        replace: bool,
        now: datetime | None = None,
    ) -> None:
        """Store closes and the new coverage in one transaction.

        ``replace`` drops the ticker's earlier closes first (a split or a
        wider range rewrites them all).
        """
        with self._pool.connection() as conn, conn.transaction():
            if replace:
                conn.execute(
                    "DELETE FROM market_daily_closes WHERE ticker = %s", (ticker,)
                )
            if rows:
                conn.execute(
                    """
                    INSERT INTO market_daily_closes (ticker, date, close)
                    SELECT %s, d, c FROM unnest(%s::date[], %s::numeric[]) AS t(d, c)
                    ON CONFLICT (ticker, date) DO UPDATE SET close = EXCLUDED.close
                    """,
                    (ticker, [d for d, _ in rows], [c for _, c in rows]),
                )
            self._upsert_coverage(
                conn, ticker, covered_from, fetched_through, STATUS_OK, now
            )

    def mark_no_history(
        self,
        ticker: str,
        *,
        covered_from: date,
        fetched_through: date,
        now: datetime | None = None,
    ) -> None:
        """Remember that the provider had no closes (retried after a day)."""
        with self._pool.connection() as conn:
            self._upsert_coverage(
                conn, ticker, covered_from, fetched_through, STATUS_NO_HISTORY, now
            )

    @staticmethod
    def _upsert_coverage(
        conn,
        ticker: str,
        covered_from: date,
        fetched_through: date,
        status: str,
        now: datetime | None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO market_history_coverage
                (ticker, covered_from, fetched_through, status, fetched_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (ticker) DO UPDATE SET
                covered_from = EXCLUDED.covered_from,
                fetched_through = EXCLUDED.fetched_through,
                status = EXCLUDED.status,
                fetched_at = EXCLUDED.fetched_at
            """,
            (ticker, covered_from, fetched_through, status, now or utcnow()),
        )


def shared_pool() -> ConnectionPool | None:
    """The service's shared database pool, or None without one."""
    # Imported here: the RAG container pulls in Pinecone and Gemini clients.
    from app.services.rag.container import get_rag_components

    try:
        return get_rag_components().pool
    except Exception as exc:  # not configured, or the pool can't open
        logger.info("market data database unavailable: %s", exc)
        return None


def shared_repository() -> MarketDataRepository | None:
    """The cache on the service's shared database pool, or None without one.

    Callers then work uncached, so market data never depends on the database.
    """
    pool = shared_pool()
    return MarketDataRepository(pool) if pool is not None else None
