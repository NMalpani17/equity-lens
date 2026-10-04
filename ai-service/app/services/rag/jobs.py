"""Ingestion coordination: claiming, daily cap, dedupe and background jobs."""

import logging
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Executor, Future, wait
from dataclasses import dataclass
from datetime import timedelta

from app.models.transcript import EarningsCallEvent

from .errors import (
    EmbeddingQuotaExhaustedError,
    EquiblesNotFoundError,
    EquiblesQuotaError,
    IngestionCapReachedError,
    IngestionInterruptedError,
    NoTranscriptsError,
    TickerUnavailableError,
)
from .ingestion import IngestionPipeline, IngestionResult
from .repository import (
    Claim,
    ClaimOutcome,
    RagRepository,
    TickerRecord,
    next_utc_midnight,
)

logger = logging.getLogger(__name__)

# Upstream errors can be kilobytes of JSON; keep stored/returned messages short.
_MAX_ERROR_CHARS = 500


def _short(exc: BaseException) -> str:
    return str(exc)[:_MAX_ERROR_CHARS]


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
        self._futures: set[Future] = set()
        self._lock = threading.Lock()
        self._stopping = threading.Event()

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
        return self._run(
            job_id,
            ticker,
            lambda should_stop: self._pipeline.ingest(
                ticker,
                refresh=refresh,
                include_plain=include_plain,
                should_stop=should_stop,
            ),
        )

    def run_refresh(
        self,
        job_id: str,
        record: TickerRecord,
        events: Sequence[EarningsCallEvent],
    ) -> JobOutcome:
        """Run a freshness refresh job: add newer calls to an indexed ticker.

        A failure leaves the ticker ``indexed``: its existing vectors still
        serve searches, and the next day's freshness check tries again.
        """
        return self._run(
            job_id,
            record.ticker,
            lambda should_stop: self._pipeline.add_newer_quarters(
                record.ticker,
                events,
                indexed_quarters=record.quarters,
                company_name=record.company_name,
                chunk_count=record.chunk_count,
                latest_call_date=record.latest_call_date,
                should_stop=should_stop,
            ),
            keep_indexed=True,
        )

    def submit_task(self, key: str, task: Callable[[], object]) -> bool:
        """Run ``task`` on the ingestion executor unless ``key`` is in flight.

        Returns False when skipped (a duplicate, or shutting down).
        """
        if self._stopping.is_set():
            return False
        with self._lock:
            if key in self._inflight:
                return False
            self._inflight.add(key)
        future = self._executor.submit(self._run_task, key, task)
        with self._lock:
            self._futures.add(future)
        future.add_done_callback(self._forget)
        return True

    def _run(
        self,
        job_id: str,
        ticker: str,
        work: Callable[[Callable[[], bool]], IngestionResult],
        *,
        keep_indexed: bool = False,
    ) -> JobOutcome:
        self._repo.mark_job_running(job_id)
        try:
            result = work(self._stopping.is_set)
        except IngestionInterruptedError:
            # Leave the job as is: the stale-job reclaim restarts it later.
            logger.warning(
                "ingestion job %s for %s interrupted by shutdown; it will be "
                "reclaimed",
                job_id,
                ticker,
            )
            return JobOutcome(succeeded=False, error="interrupted")
        except (NoTranscriptsError, EquiblesNotFoundError) as exc:
            logger.warning("no transcripts for %s: %s", ticker, exc)
            self._fail(job_id, ticker, exc, unavailable=True, keep=keep_indexed)
            return JobOutcome(succeeded=False, error=_short(exc))
        except (EquiblesQuotaError, EmbeddingQuotaExhaustedError) as exc:
            logger.error("daily quota exhausted while ingesting %s: %s", ticker, exc)
            self._fail(job_id, ticker, exc, unavailable=False, keep=keep_indexed)
            return JobOutcome(succeeded=False, error=_short(exc), quota_exhausted=True)
        except Exception as exc:
            logger.exception("ingestion job %s for %s failed", job_id, ticker)
            self._fail(job_id, ticker, exc, unavailable=False, keep=keep_indexed)
            return JobOutcome(succeeded=False, error=_short(exc))

        self._repo.complete_job(
            job_id,
            ticker,
            company_name=result.company_name,
            chunk_count=result.chunk_count,
            quarters=result.quarters,
            latest_call_date=result.latest_call_date,
        )
        return JobOutcome(succeeded=True, result=result)

    def _fail(
        self,
        job_id: str,
        ticker: str,
        exc: BaseException,
        *,
        unavailable: bool,
        keep: bool,
    ) -> None:
        self._repo.fail_job(
            job_id,
            ticker,
            error=_short(exc),
            unavailable=unavailable,
            keep_indexed=keep,
        )

    def shutdown(self, timeout: float) -> bool:
        """Stop background ingestion, waiting at most ``timeout`` seconds.

        Running jobs stop at their next stage boundary and queued ones are
        cancelled; either way the claimed job is left for the stale-job
        reclaim. Returns True if no job was still running when it returned.
        """
        self._stopping.set()
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            pending = set(self._futures)
        _, still_running = wait(pending, timeout=timeout)
        if still_running:
            logger.warning(
                "%d ingestion job(s) still running at shutdown; they will be "
                "reclaimed",
                len(still_running),
            )
        return not still_running

    def _submit(self, job_id: str, ticker: str) -> None:
        if self._stopping.is_set():
            logger.warning("shutting down; leaving job %s for reclaim", job_id)
            return
        # The DB claim already dedupes across processes; the in-flight key
        # guards against double-submitting within one process.
        if self.submit_task(ticker, lambda: self.run_job(job_id, ticker)):
            logger.info("queued background ingestion job %s for %s", job_id, ticker)

    def _forget(self, future: Future) -> None:
        with self._lock:
            self._futures.discard(future)

    def _run_task(self, key: str, task: Callable[[], object]) -> None:
        try:
            task()
        except Exception:
            # Jobs record pipeline failures themselves; this catches DB errors
            # that would otherwise vanish inside the executor.
            logger.exception("background task %s crashed", key)
        finally:
            with self._lock:
                self._inflight.discard(key)
