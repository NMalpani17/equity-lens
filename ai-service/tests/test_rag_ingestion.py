"""Tests for the ingestion pipeline and coordinator using in-memory fakes."""

from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from app.services.rag.errors import (
    EquiblesQuotaError,
    IngestionCapReachedError,
    NoTranscriptsError,
    TickerUnavailableError,
)
from app.services.rag.ingestion import IngestionPipeline, TranscriptSource
from app.services.rag.jobs import IngestionCoordinator
from app.services.rag.repository import ClaimOutcome
from tests.rag_fakes import (
    FakeEmbedder,
    FakeEquibles,
    FakeRepo,
    FakeSparse,
    InlineExecutor,
)

PERIODS = {"AAPL": [(2025, 4), (2025, 3), (2025, 2), (2025, 1)]}


def build(
    equibles: FakeEquibles | None = None,
    repo: FakeRepo | None = None,
    quarters: int = 4,
):
    equibles = equibles or FakeEquibles(PERIODS)
    repo = repo or FakeRepo()
    store = MagicMock()
    store.upsert_chunks.side_effect = lambda chunks, *a, **k: len(chunks)
    pipeline = IngestionPipeline(
        TranscriptSource(equibles, repo, quarters=quarters),
        FakeEmbedder(),
        FakeSparse(),
        store,
        namespace="ctx",
        plain_namespace="plain",
        chunk_tokens=400,
        overlap_tokens=60,
    )
    return pipeline, equibles, repo, store


def test_first_run_fetches_and_caches_then_reruns_use_cache_only() -> None:
    pipeline, equibles, repo, store = build()

    result = pipeline.ingest("AAPL")

    assert result.quarters == ["FY2025Q4", "FY2025Q3", "FY2025Q2", "FY2025Q1"]
    assert result.company_name == "AAPL Holdings Inc"
    assert result.chunk_count == 12
    store.ensure_index.assert_called()  # works even before the seed script ran
    assert len(repo.transcripts) == 4
    assert len(equibles.calls) == 5  # 1 list + 4 transcripts

    equibles.calls.clear()
    again = pipeline.ingest("AAPL")

    assert equibles.calls == []  # served entirely from the Postgres cache
    assert again.chunk_count == result.chunk_count
    upserted_ids = [
        [c.id for c in call.args[0]] for call in store.upsert_chunks.call_args_list
    ]
    assert upserted_ids[0] == upserted_ids[1]  # stable IDs -> idempotent


def test_missing_transcripts_are_skipped() -> None:
    equibles = FakeEquibles(PERIODS)
    equibles.missing.add(("AAPL", 2025, 3))
    pipeline, *_ = build(equibles)

    result = pipeline.ingest("AAPL")

    assert result.quarters == ["FY2025Q4", "FY2025Q2", "FY2025Q1"]


def test_unknown_ticker_raises_no_transcripts() -> None:
    pipeline, *_ = build()

    with pytest.raises(NoTranscriptsError):
        pipeline.ingest("ZZZZ")


def test_refresh_refetches_even_when_cached() -> None:
    pipeline, equibles, *_ = build()
    pipeline.ingest("AAPL")
    equibles.calls.clear()

    pipeline.ingest("AAPL", refresh=True)

    assert len(equibles.calls) == 5


def test_include_plain_indexes_header_less_copy_and_cleans_stale_ids() -> None:
    pipeline, _, _, store = build()

    pipeline.ingest("AAPL", include_plain=True)

    namespaces = [c.kwargs["namespace"] for c in store.upsert_chunks.call_args_list]
    assert namespaces == ["ctx", "plain"]
    prefixes = {c.args[0] for c in store.delete_stale.call_args_list}
    assert prefixes == {"AAPL#"}


def make_coordinator(repo: FakeRepo, run_jobs: bool = True, cap: int = 8):
    pipeline, equibles, _, store = build(repo=repo)
    executor = InlineExecutor(run=run_jobs)
    coordinator = IngestionCoordinator(
        repo,
        pipeline,
        executor,
        daily_cap=cap,
        stale_after=timedelta(minutes=30),
    )
    return coordinator, executor, equibles


def test_on_demand_request_runs_job_and_marks_indexed() -> None:
    repo = FakeRepo()
    coordinator, executor, _ = make_coordinator(repo)

    claim = coordinator.request_on_demand("AAPL")

    assert claim.outcome is ClaimOutcome.STARTED
    assert len(executor.submitted) == 1
    assert repo.tickers["AAPL"].status == "indexed"
    assert repo.jobs[claim.job_id].status == "succeeded"
    assert repo.daily_used == 1


def test_concurrent_requests_are_deduped() -> None:
    repo = FakeRepo()
    coordinator, executor, _ = make_coordinator(repo, run_jobs=False)

    first = coordinator.request_on_demand("AAPL")
    second = coordinator.request_on_demand("AAPL")

    assert second.outcome is ClaimOutcome.ALREADY_INDEXING
    assert second.job_id == first.job_id
    assert len(executor.submitted) == 1
    assert repo.daily_used == 1


def test_daily_cap_raises_clear_error() -> None:
    repo = FakeRepo(daily_cap_used=8)
    coordinator, executor, _ = make_coordinator(repo)

    with pytest.raises(IngestionCapReachedError) as exc_info:
        coordinator.request_on_demand("AAPL")

    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["cap"] == 8
    assert executor.submitted == []


def test_unknown_ticker_becomes_unavailable_and_is_not_retried() -> None:
    repo = FakeRepo()
    coordinator, executor, _ = make_coordinator(repo)

    coordinator.request_on_demand("ZZZZ")  # job runs and finds nothing

    assert repo.tickers["ZZZZ"].status == "unavailable"
    with pytest.raises(TickerUnavailableError):
        coordinator.request_on_demand("ZZZZ")
    assert len(executor.submitted) == 1


def test_quota_exhaustion_marks_job_failed() -> None:
    repo = FakeRepo()
    coordinator, _, equibles = make_coordinator(repo, run_jobs=False)
    claim = coordinator.request_on_demand("AAPL")
    equibles.list_earnings_calls = MagicMock(side_effect=EquiblesQuotaError("429"))

    outcome = coordinator.run_job(claim.job_id, "AAPL")

    assert not outcome.succeeded and outcome.quota_exhausted
    assert repo.tickers["AAPL"].status == "failed"
    assert repo.jobs[claim.job_id].status == "failed"


def test_plain_only_indexes_just_the_eval_namespace() -> None:
    pipeline, _, _, store = build()
    pipeline.ingest("AAPL")
    store.reset_mock()

    pipeline.ingest("AAPL", cache_only=True, plain_only=True)

    namespaces = [c.kwargs["namespace"] for c in store.upsert_chunks.call_args_list]
    assert namespaces == ["plain"]
    embedded = pipeline._embedder.last_texts
    assert embedded and not any(t.startswith("AAPL (") for t in embedded)


def test_company_name_is_consistent_across_quarters() -> None:
    equibles = FakeEquibles(PERIODS)
    original = equibles.get_transcript

    def odd_latest_title(ticker, fy, fq):
        payload = original(ticker, fy, fq)
        if (fy, fq) == (2025, 4):
            payload["eventTitle"] = "2025 Q4 Earnings Call"
        return payload

    equibles.get_transcript = odd_latest_title
    pipeline, _, _, store = build(equibles)

    result = pipeline.ingest("AAPL")

    assert result.company_name == "AAPL Holdings Inc"
    chunks = store.upsert_chunks.call_args.args[0]
    assert {c.company_name for c in chunks} == {"AAPL Holdings Inc"}


def test_embedding_daily_quota_stops_like_equibles_quota() -> None:
    from app.services.rag.errors import EmbeddingQuotaExhaustedError

    repo = FakeRepo()
    coordinator, _, _ = make_coordinator(repo, run_jobs=False)
    claim = coordinator.request_on_demand("AAPL")
    coordinator._pipeline._embedder.embed_documents = MagicMock(
        side_effect=EmbeddingQuotaExhaustedError("daily")
    )

    outcome = coordinator.run_job(claim.job_id, "AAPL")

    assert outcome.quota_exhausted
    assert repo.tickers["AAPL"].status == "failed"
