"""In-memory fakes for RAG collaborators, shared by the RAG tests."""

import uuid
from collections.abc import Sequence
from concurrent.futures import Future
from datetime import date, datetime, timedelta
from typing import Any

from app.models.transcript import EarningsCallEvent
from app.services.rag.embeddings import SparseVector
from app.services.rag.errors import EquiblesNotFoundError
from app.services.rag.repository import (
    CachedTranscript,
    Claim,
    ClaimOutcome,
    JobRecord,
    TickerRecord,
    utcnow,
)


def transcript_payload(ticker: str, fy: int, fq: int, n_turns: int = 3) -> dict:
    return {
        "ticker": ticker,
        "eventTitle": f"{ticker} Holdings Inc Q{fq} FY{fy} Earnings Call",
        "callDate": f"{fy}-0{fq}-15T00:00:00+00:00",
        "fiscalYear": fy,
        "fiscalQuarter": fq,
        "data": [
            {
                "speakerIndex": i,
                "speakerName": None,
                "speakerRole": "CEO" if i == 0 else "Analyst",
                "text": f"Turn {i} discusses revenue growth and EBITDA margins in "
                f"fiscal {fy} quarter {fq} in some detail.",
            }
            for i in range(n_turns)
        ],
    }


class FakeEquibles:
    def __init__(self, periods: dict[str, list[tuple[int, int]]]) -> None:
        self.periods = periods
        self.missing: set[tuple[str, int, int]] = set()
        self.calls: list[str] = []

    def list_earnings_calls(self, ticker: str) -> list[EarningsCallEvent]:
        self.calls.append(f"list:{ticker}")
        if ticker not in self.periods:
            raise EquiblesNotFoundError(ticker)
        return [
            EarningsCallEvent(
                id=f"{ticker}-{fy}-{fq}",
                fiscalYear=fy,
                fiscalQuarter=fq,
                hasTranscript=True,
                callDate=datetime(fy, fq, 15),
            )
            for fy, fq in self.periods[ticker]
        ]

    def get_transcript(self, ticker: str, fy: int, fq: int) -> dict:
        self.calls.append(f"get:{ticker}:{fy}Q{fq}")
        if (ticker, fy, fq) in self.missing:
            raise EquiblesNotFoundError(ticker)
        return transcript_payload(ticker, fy, fq)


class FakeEmbedder:
    def __init__(self) -> None:
        self.document_calls = 0
        self.last_texts: list[str] = []
        self.queries: list[str] = []

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        self.document_calls += 1
        self.last_texts = list(texts)
        return [[1.0, 0.0] for _ in texts]

    def embed_query(self, text: str) -> list[float]:
        self.queries.append(text)
        return [0.6, 0.8]


class FakeSparse:
    def encode_documents(self, texts: Sequence[str]) -> list[SparseVector]:
        return [SparseVector([1], [1.0]) for _ in texts]

    def encode_query(self, text: str) -> SparseVector:
        return SparseVector([1, 2], [1.0, 0.5])


class FakeRepo:
    """Mimics RagRepository's claim semantics without a database."""

    def __init__(self, daily_cap_used: int = 0, refreshes_used: int = 0) -> None:
        self.transcripts: dict[tuple[str, int, int], dict] = {}
        self.tickers: dict[str, TickerRecord] = {}
        self.jobs: dict[str, JobRecord] = {}
        self.daily_used = daily_cap_used
        self.refreshes_used = refreshes_used

    # transcripts
    def get_cached_transcripts(self, ticker: str) -> list[CachedTranscript]:
        rows = [
            CachedTranscript(fy, fq, payload)
            for (t, fy, fq), payload in self.transcripts.items()
            if t == ticker
        ]
        return sorted(
            rows, key=lambda r: (r.fiscal_year, r.fiscal_quarter), reverse=True
        )

    def save_transcript(self, ticker, fy, fq, payload, **_: Any) -> None:
        self.transcripts[(ticker, fy, fq)] = payload

    # tickers / jobs
    def get_ticker(self, ticker: str) -> TickerRecord | None:
        return self.tickers.get(ticker)

    def list_tickers(self) -> list[TickerRecord]:
        return sorted(self.tickers.values(), key=lambda t: t.ticker)

    def get_job(self, job_id: str) -> JobRecord | None:
        return self.jobs.get(job_id)

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
        record = self.tickers.get(ticker)
        if record is not None:
            if record.status == "indexing":
                return Claim(ClaimOutcome.ALREADY_INDEXING, record.last_job_id)
            if refresh and record.status != "indexed":
                return Claim(ClaimOutcome.NOT_INDEXED)
            if record.status == "indexed" and not (force or refresh):
                return Claim(ClaimOutcome.ALREADY_INDEXED)
            if record.status == "unavailable" and not force:
                return Claim(ClaimOutcome.UNAVAILABLE)
        elif refresh:
            return Claim(ClaimOutcome.NOT_INDEXED)
        if daily_cap is not None:
            used = self.refreshes_used if refresh else self.daily_used
            if used >= daily_cap:
                return Claim(ClaimOutcome.CAP_REACHED)
            if refresh:
                self.refreshes_used += 1
            else:
                self.daily_used += 1
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = JobRecord(
            job_id, ticker, "queued", trigger, 0, None, utcnow(), None, None
        )
        self.tickers[ticker] = TickerRecord(
            **{
                **(record.__dict__ if record else {"ticker": ticker}),
                "status": "indexing",
                "company_name": record.company_name if record else None,
                "chunk_count": record.chunk_count if record else 0,
                "quarters": record.quarters if record else [],
                "last_job_id": job_id,
                "last_error": None,
            }
        )
        return Claim(ClaimOutcome.STARTED, job_id)

    def claim_freshness_check(self, ticker: str, *, now: datetime) -> bool:
        record = self.tickers.get(ticker)
        if (
            record is None
            or record.indexed_at is None
            or record.status not in ("indexed", "indexing")
        ):
            return False
        checked = record.freshness_checked_at
        if checked is not None and checked.date() >= now.date():
            return False
        self.tickers[ticker] = TickerRecord(
            **{**record.__dict__, "freshness_checked_at": now}
        )
        return True

    def _update_job(self, job_id: str, **changes: Any) -> None:
        job = self.jobs[job_id]
        self.jobs[job_id] = JobRecord(**{**job.__dict__, **changes})

    def mark_job_running(self, job_id: str) -> None:
        self._update_job(job_id, status="running", started_at=utcnow())

    def complete_job(
        self,
        job_id,
        ticker,
        *,
        company_name,
        chunk_count,
        quarters,
        latest_call_date=None,
    ):
        self._update_job(
            job_id, status="succeeded", chunk_count=chunk_count, finished_at=utcnow()
        )
        old = self.tickers.get(ticker)
        self.tickers[ticker] = TickerRecord(
            ticker=ticker,
            status="indexed",
            company_name=company_name,
            chunk_count=chunk_count,
            quarters=quarters,
            last_job_id=job_id,
            indexed_at=utcnow(),
            latest_call_date=latest_call_date or (old and old.latest_call_date),
            freshness_checked_at=old.freshness_checked_at if old else None,
        )

    def fail_job(self, job_id, ticker, *, error, unavailable, keep_indexed=False):
        self._update_job(job_id, status="failed", error=error, finished_at=utcnow())
        old = self.tickers[ticker]
        if keep_indexed:
            status = "indexed"
        else:
            status = "unavailable" if unavailable else "failed"
        self.tickers[ticker] = TickerRecord(
            **{**old.__dict__, "status": status, "last_error": error}
        )


class InlineExecutor:
    """Runs submitted work immediately (deterministic background jobs)."""

    def __init__(self, run: bool = True) -> None:
        self.run = run
        self.submitted: list[tuple[Any, ...]] = []

    def submit(self, fn, *args) -> Future:
        """Like Executor.submit: returns a Future (already done if it ran)."""
        self.submitted.append(args)
        future: Future = Future()
        if self.run:
            future.set_result(fn(*args))
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        self.shut_down = True
