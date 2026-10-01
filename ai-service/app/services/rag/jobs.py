"""Ingestion coordination: claiming, daily cap, dedupe and background jobs."""

import logging
import threading
from concurrent.futures import Executor
from dataclasses import dataclass
from datetime import timedelta

from .errors import (
    EquiblesNotFoundError,
    EquiblesQuotaError,
    IngestionCapReachedError,
    NoTranscriptsError,
    TickerUnavailableError,
)
from .ingestion import IngestionPipeline, IngestionResult
from .repository import Claim, ClaimOutcome, RagRepository, next_utc_midnight

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobOutcome:
    """Result of running one ingestion job synchronously."""

    succeeded: bool
    result: IngestionResult | None = None
    error: str | None = None
    quota_exhausted: bool = False


class IngestionCoordinator:
    def __init__(
        self,
        repo: RagRepository,
        pipeline: IngestionPipeline,
        executor: Executor,
        *,
        daily_cap: int,
        stale_after: timedelta,
    ) -> None:
        self._repo = repo
        self._pipeline = pipeline
        self._executor = executor
        self._daily_cap = daily_cap
        self._stale_after = stale_after
        self._inflight: set[str] = set()
        self._lock = threading.Lock()

    def request_on_demand(self, ticker: str) -> Claim:
        """Start (or join) background ingestion for a ticker a user searched.

        Returns the claim (STARTED / ALREADY_INDEXING carry a job id, and
        ALREADY_INDEXED means the caller can search right away). Raises when the
        ticker has no transcripts or today's cap is used up.
        """
        claim = self._repo.claim_ingestion(
            ticker,
            trigger="on_demand",
            daily_cap=self._daily_cap,
            stale_after=self._stale_after,
        )
        match claim.outcome:
            case ClaimOutcome.STARTED:
                assert claim.job_id is not None
                self._submit(claim.job_id, ticker)
            case ClaimOutcome.UNAVAILABLE:
                raise TickerUnavailableError(ticker)
            case ClaimOutcome.CAP_REACHED:
                logger.warning("daily ingestion cap reached; refusing %s", ticker)
                raise IngestionCapReachedError(
                    ticker, self._daily_cap, next_utc_midnight()
                )
        return claim

    def run_job(
        self,
        job_id: str,
        ticker: str,
        *,
        refresh: bool = False,
        include_plain: bool = False,
    ) -> JobOutcome:
        """Run one ingestion job to completion, recording its status."""
        self._repo.mark_job_running(job_id)
        try:
            result = self._pipeline.ingest(
                ticker, refresh=refresh, include_plain=include_plain
            )
        except (NoTranscriptsError, EquiblesNotFoundError) as exc:
            logger.warning("no transcripts for %s: %s", ticker, exc)
            self._repo.fail_job(job_id, ticker, error=str(exc), unavailable=True)
            return JobOutcome(succeeded=False, error=str(exc))
        except EquiblesQuotaError as exc:
            logger.error("equibles quota exhausted while ingesting %s", ticker)
            self._repo.fail_job(job_id, ticker, error=str(exc), unavailable=False)
            return JobOutcome(succeeded=False, error=str(exc), quota_exhausted=True)
        except Exception as exc:
            logger.exception("ingestion job %s for %s failed", job_id, ticker)
            self._repo.fail_job(job_id, ticker, error=str(exc), unavailable=False)
            return JobOutcome(succeeded=False, error=str(exc))

        self._repo.complete_job(
            job_id,
            ticker,
            company_name=result.company_name,
            chunk_count=result.chunk_count,
            quarters=result.quarters,
        )
        return JobOutcome(succeeded=True, result=result)

    def _submit(self, job_id: str, ticker: str) -> None:
        # The DB claim already dedupes across processes; this guards against
        # double-submitting within one process.
        with self._lock:
            if ticker in self._inflight:
                return
            self._inflight.add(ticker)
        logger.info("queued background ingestion job %s for %s", job_id, ticker)
        self._executor.submit(self._run_in_background, job_id, ticker)

    def _run_in_background(self, job_id: str, ticker: str) -> None:
        try:
            self.run_job(job_id, ticker)
        except Exception:
            # run_job records pipeline failures itself; this catches DB errors
            # that would otherwise vanish inside the executor.
            logger.exception("background ingestion %s for %s crashed", job_id, ticker)
        finally:
            with self._lock:
                self._inflight.discard(ticker)
