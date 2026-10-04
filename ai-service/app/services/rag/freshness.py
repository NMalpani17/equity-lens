"""Freshness refresh: keep indexed tickers' transcripts current.

When a search hits an indexed ticker whose newest indexed call is older than
``stale_after_days``, a background task asks Equibles whether a newer call
exists. That happens at most once per ticker per UTC day (recorded in
Postgres). If there is one, a refresh job (with its own daily cap) indexes it
and drops the quarter that falls out of the window. Nothing here runs in, or
slows, the request that triggered it: searches keep using what is indexed.
"""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from enum import StrEnum

from app.models.transcript import parse_period_label, period_label

from .equibles import EquiblesClient
from .jobs import IngestionCoordinator
from .repository import ClaimOutcome, RagRepository, TickerRecord, utcnow

logger = logging.getLogger(__name__)

_MAX_ERROR_CHARS = 200


class FreshnessOutcome(StrEnum):
    UP_TO_DATE = "up_to_date"
    REFRESH_STARTED = "refresh_started"
    REFRESH_CAP_REACHED = "refresh_cap_reached"
    ALREADY_INDEXING = "already_indexing"
    ALREADY_CHECKED = "already_checked"
    NOT_INDEXED = "not_indexed"
    ERROR = "error"


def needs_check(record: TickerRecord, *, now: datetime, stale_after: timedelta) -> bool:
    """True when a searchable ticker looks stale and wasn't checked today."""
    if record.indexed_at is None or record.status not in ("indexed", "indexing"):
        return False
    checked = record.freshness_checked_at
    if checked is not None and checked.date() >= now.date():
        return False
    latest = record.latest_call_date
    return latest is None or now.date() - latest > stale_after


def _newest(periods: list[tuple[int, int]]) -> tuple[int, int] | None:
    return max(periods, default=None)


def _label(period: tuple[int, int] | None) -> str | None:
    return period_label(*period) if period else None


class FreshnessRefresher:
    def __init__(
        self,
        repo: RagRepository,
        equibles: EquiblesClient,
        coordinator: IngestionCoordinator,
        *,
        stale_after_days: int,
        daily_cap: int,
        stale_job_after: timedelta,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._repo = repo
        self._equibles = equibles
        self._coordinator = coordinator
        self._stale_after = timedelta(days=stale_after_days)
        self._daily_cap = daily_cap
        self._stale_job_after = stale_job_after
        self._clock = clock

    def maybe_check(self, record: TickerRecord) -> bool:
        """Queue a background check if ``record`` is due one. Never raises.

        Called on the search path, so it only compares fields of the record
        the search already read; the Equibles call happens in the background.
        """
        try:
            if self._daily_cap <= 0 or not needs_check(
                record, now=self._clock(), stale_after=self._stale_after
            ):
                return False
            ticker = record.ticker
            return self._coordinator.submit_task(
                f"freshness:{ticker}", lambda: self.check(ticker)
            )
        except Exception:
            logger.exception("could not queue freshness check for %s", record.ticker)
            return False

    def check(self, ticker: str) -> FreshnessOutcome:
        """Check Equibles for a newer call and refresh the index if there is one.

        Runs in the background. A started refresh job runs to completion in
        this same task.
        """
        if not self._repo.claim_freshness_check(ticker, now=self._clock()):
            return self._log(ticker, FreshnessOutcome.ALREADY_CHECKED)
        record = self._repo.get_ticker(ticker)
        if record is None:
            return self._log(ticker, FreshnessOutcome.NOT_INDEXED)
        indexed = _newest(
            [p for label in record.quarters if (p := parse_period_label(label))]
        )
        try:
            events = self._equibles.list_earnings_calls(ticker)
        except Exception as exc:
            return self._log(
                ticker,
                FreshnessOutcome.ERROR,
                newest_indexed=indexed,
                error=str(exc)[:_MAX_ERROR_CHARS],
            )
        available = _newest(
            [
                (e.fiscal_year, e.fiscal_quarter)
                for e in events
                if e.fiscal_year is not None and e.fiscal_quarter is not None
            ]
        )
        if available is None or (indexed is not None and available <= indexed):
            return self._log(
                ticker, FreshnessOutcome.UP_TO_DATE, indexed, available=available
            )

        claim = self._repo.claim_ingestion(
            ticker,
            trigger="refresh",
            daily_cap=self._daily_cap,
            stale_after=self._stale_job_after,
            refresh=True,
        )
        match claim.outcome:
            case ClaimOutcome.STARTED:
                assert claim.job_id is not None
                self._log(
                    ticker,
                    FreshnessOutcome.REFRESH_STARTED,
                    indexed,
                    available=available,
                    job_id=claim.job_id,
                )
                job = self._coordinator.run_refresh(claim.job_id, record, events)
                logger.info(
                    "freshness refresh for %s %s",
                    ticker,
                    "succeeded" if job.succeeded else "failed",
                    extra={
                        "fields": {
                            "event": "rag_freshness_refresh",
                            "ticker": ticker,
                            "job_id": claim.job_id,
                            "succeeded": job.succeeded,
                            "quarters": job.result.quarters if job.result else None,
                            "error": job.error,
                        }
                    },
                )
                return FreshnessOutcome.REFRESH_STARTED
            case ClaimOutcome.CAP_REACHED:
                outcome = FreshnessOutcome.REFRESH_CAP_REACHED
            case ClaimOutcome.ALREADY_INDEXING:
                outcome = FreshnessOutcome.ALREADY_INDEXING
            case _:
                outcome = FreshnessOutcome.NOT_INDEXED
        return self._log(ticker, outcome, indexed, available=available)

    def _log(
        self,
        ticker: str,
        outcome: FreshnessOutcome,
        newest_indexed: tuple[int, int] | None = None,
        *,
        available: tuple[int, int] | None = None,
        job_id: str | None = None,
        error: str | None = None,
    ) -> FreshnessOutcome:
        fields = {
            "event": "rag_freshness_check",
            "ticker": ticker,
            "outcome": outcome.value,
            "newest_indexed": _label(newest_indexed),
            "newest_available": _label(available),
            "job_id": job_id,
            "error": error,
        }
        level = logging.WARNING if outcome is FreshnessOutcome.ERROR else logging.INFO
        logger.log(
            level,
            "freshness check for %s: %s",
            ticker,
            outcome.value,
            extra={"fields": {k: v for k, v in fields.items() if v is not None}},
        )
        return outcome
