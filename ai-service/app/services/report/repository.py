"""Postgres persistence for research reports (Supabase, via psycopg).

The ``research_reports`` table is owned by Prisma (``api/prisma/schema.prisma``);
the ai-service writes it and the api gateway reads it. Timestamps are naive
UTC, matching Prisma's ``TIMESTAMP(3)``.

One row per ticker and fiscal quarter. A generation first *claims* the row
(``generating_since`` + ``generation_id``), so at most one generation runs per
report at a time, across processes; it then saves the content or releases the
claim. A claim older than the stale window is assumed dead and can be taken.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from app.services.rag.repository import utcnow


class ClaimOutcome(StrEnum):
    CLAIMED = "claimed"
    # Another generation holds a live claim.
    IN_PROGRESS = "in_progress"
    # A report for this quarter is newer than the regenerate window.
    FRESH = "fresh"


@dataclass(frozen=True)
class Claim:
    outcome: ClaimOutcome
    generation_id: str | None = None
    # When the existing report was generated (FRESH), for the error message.
    generated_at: datetime | None = None


@dataclass(frozen=True)
class StoredReport:
    ticker: str
    fiscal_year: int
    fiscal_quarter: int
    company_name: str | None
    content: dict[str, Any] | None
    generated_at: datetime | None
    trace_id: str | None


class ReportRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def claim(
        self,
        ticker: str,
        fiscal_year: int,
        fiscal_quarter: int,
        *,
        regenerate_after: timedelta,
        stale_after: timedelta,
        now: datetime | None = None,
    ) -> Claim:
        """Claim the report for one generation, unless it's busy or fresh.

        ``regenerate_after`` of zero always allows a new generation.
        """
        now = now or utcnow()
        key = (ticker, fiscal_year, fiscal_quarter)
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """
                INSERT INTO research_reports
                    (id, ticker, fiscal_year, fiscal_quarter, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (ticker, fiscal_year, fiscal_quarter) DO NOTHING
                """,
                (str(uuid.uuid4()), *key, now, now),
            )
            row = conn.execute(
                """
                SELECT generated_at, generating_since,
                       content IS NOT NULL AS has_content
                FROM research_reports
                WHERE ticker = %s AND fiscal_year = %s AND fiscal_quarter = %s
                FOR UPDATE
                """,
                key,
            ).fetchone()
            assert row is not None
            since = row["generating_since"]
            if since is not None and since > now - stale_after:
                return Claim(ClaimOutcome.IN_PROGRESS)
            generated = row["generated_at"]
            if (
                row["has_content"]
                and regenerate_after > timedelta(0)
                and generated is not None
                and generated > now - regenerate_after
            ):
                return Claim(ClaimOutcome.FRESH, generated_at=generated)
            generation_id = str(uuid.uuid4())
            conn.execute(
                """
                UPDATE research_reports
                SET generating_since = %s, generation_id = %s, updated_at = %s
                WHERE ticker = %s AND fiscal_year = %s AND fiscal_quarter = %s
                """,
                (now, generation_id, now, *key),
            )
            return Claim(ClaimOutcome.CLAIMED, generation_id)

    def save(
        self,
        generation_id: str,
        *,
        content: dict[str, Any],
        company_name: str,
        trace_id: str | None,
        now: datetime | None = None,
    ) -> datetime | None:
        """Store the report and release the claim; None if the claim was lost."""
        now = now or utcnow()
        with self._pool.connection() as conn:
            row = conn.execute(
                """
                UPDATE research_reports
                SET content = %s, company_name = %s, generated_at = %s,
                    trace_id = %s, generating_since = NULL, generation_id = NULL,
                    updated_at = %s
                WHERE generation_id = %s
                RETURNING generated_at
                """,
                (Jsonb(content), company_name, now, trace_id, now, generation_id),
            ).fetchone()
        return row["generated_at"] if row else None

    def release(self, generation_id: str) -> None:
        """Drop a claim without saving (failed or cancelled generation)."""
        with self._pool.connection() as conn:
            conn.execute(
                """
                UPDATE research_reports
                SET generating_since = NULL, generation_id = NULL, updated_at = %s
                WHERE generation_id = %s
                """,
                (utcnow(), generation_id),
            )

    def get(
        self, ticker: str, fiscal_year: int, fiscal_quarter: int
    ) -> StoredReport | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                """
                SELECT ticker, fiscal_year, fiscal_quarter, company_name, content,
                       generated_at, trace_id
                FROM research_reports
                WHERE ticker = %s AND fiscal_year = %s AND fiscal_quarter = %s
                """,
                (ticker, fiscal_year, fiscal_quarter),
            ).fetchone()
        return StoredReport(**row) if row else None
