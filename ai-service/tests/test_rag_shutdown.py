"""Graceful shutdown: ingestion stops in bounded time and stays recoverable."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.services.rag.errors import IngestionInterruptedError
from app.services.rag.jobs import IngestionCoordinator
from app.services.rag.repository import ClaimOutcome
from tests.rag_fakes import FakeRepo
from tests.test_rag_ingestion import build


class CooperativePipeline:
    """Works until told to stop, like the real pipeline between stages."""

    def __init__(self) -> None:
        self.started = threading.Event()

    def ingest(self, ticker, *, should_stop, **_):
        self.started.set()
        while not should_stop():
            time.sleep(0.01)
        raise IngestionInterruptedError(ticker)


class StuckPipeline:
    """Ignores the stop flag (e.g. blocked inside a slow upstream call)."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def ingest(self, ticker, **_):
        self.started.set()
        self.release.wait(10)
        raise IngestionInterruptedError(ticker)


def coordinator(pipeline, repo: FakeRepo) -> IngestionCoordinator:
    return IngestionCoordinator(
        repo,
        pipeline,
        ThreadPoolExecutor(max_workers=1),
        daily_cap=8,
        stale_after=timedelta(minutes=30),
    )


def test_shutdown_stops_a_running_job_and_leaves_it_reclaimable() -> None:
    repo, pipeline = FakeRepo(), CooperativePipeline()
    jobs = coordinator(pipeline, repo)
    claim = jobs.request_on_demand("NKE")
    assert claim.outcome is ClaimOutcome.STARTED
    assert pipeline.started.wait(2)

    started = time.perf_counter()
    stopped = jobs.shutdown(timeout=2.0)

    assert stopped is True and time.perf_counter() - started < 1.0
    # Neither failed nor succeeded: the stale-job reclaim restarts it later.
    assert repo.get_job(claim.job_id).status == "running"
    assert repo.get_ticker("NKE").status == "indexing"


def test_shutdown_never_waits_longer_than_its_timeout() -> None:
    repo, pipeline = FakeRepo(), StuckPipeline()
    jobs = coordinator(pipeline, repo)
    jobs.request_on_demand("NKE")
    assert pipeline.started.wait(2)

    started = time.perf_counter()
    stopped = jobs.shutdown(timeout=0.2)
    elapsed = time.perf_counter() - started
    pipeline.release.set()

    assert stopped is False
    assert elapsed < 1.0


def test_no_new_jobs_start_after_shutdown() -> None:
    repo, pipeline = FakeRepo(), CooperativePipeline()
    jobs = coordinator(pipeline, repo)
    jobs.shutdown(timeout=0.1)

    claim = jobs.request_on_demand("SBUX")

    assert not pipeline.started.wait(0.2)  # never ran
    assert repo.get_ticker("SBUX").status == "indexing"  # left for reclaim
    assert repo.get_job(claim.job_id).status == "queued"


def test_the_real_pipeline_stops_at_the_next_stage() -> None:
    pipeline, _equibles, _repo, store = build()
    checks = iter([False, True])  # stop requested after the transcripts load

    with pytest.raises(IngestionInterruptedError):
        pipeline.ingest("AAPL", should_stop=lambda: next(checks, True))

    store.upsert_chunks.assert_not_called()


def test_an_interrupted_job_is_not_recorded_as_failed() -> None:
    pipeline, _equibles, repo, _store = build()
    jobs = IngestionCoordinator(
        repo,
        pipeline,
        MagicMock(),
        daily_cap=8,
        stale_after=timedelta(minutes=30),
    )
    claim = repo.claim_ingestion(
        "AAPL", trigger="on_demand", daily_cap=8, stale_after=timedelta(minutes=30)
    )
    jobs._stopping.set()  # shutdown already requested

    outcome = jobs.run_job(claim.job_id, "AAPL")

    assert outcome.succeeded is False and outcome.error == "interrupted"
    assert repo.get_job(claim.job_id).status == "running"
    assert repo.get_ticker("AAPL").status == "indexing"


def test_app_shutdown_stops_ingestion_then_flushes_traces(monkeypatch) -> None:
    import app.main as main

    calls: list[tuple[str, float]] = []
    monkeypatch.setattr(
        main, "shutdown_rag_components", lambda timeout: calls.append(("rag", timeout))
    )
    monkeypatch.setattr(
        main, "shutdown_tracer", lambda timeout: calls.append(("tracing", timeout))
    )

    with TestClient(main.app):
        pass

    assert calls == [("rag", 3.0), ("tracing", 2.0)]
    assert sum(t for _, t in calls) < 10  # inside Cloud Run's SIGTERM grace
