"""Tests for the hybrid search service (fakes for every external dependency)."""

import json
import logging
from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from app.logging_config import JsonFormatter
from app.models.rag import RagFilters, RagSearchRequest
from app.services.rag.cache import TTLCache
from app.services.rag.embeddings import SparseVector
from app.services.rag.errors import RerankUnavailableError, SearchUpstreamError
from app.services.rag.jobs import IngestionCoordinator
from app.services.rag.repository import TickerRecord, utcnow
from app.services.rag.reranker import RerankedItem
from app.services.rag.search import (
    RagSearchService,
    RetrievalMode,
    build_filter,
    hybrid_scale,
)
from app.services.rag.vector_store import SearchHit
from tests.rag_fakes import FakeEmbedder, FakeRepo, FakeSparse, InlineExecutor


def hit(i: int, score: float) -> SearchHit:
    return SearchHit(
        id=f"AAPL#FY2025Q3#{i:04d}",
        score=score,
        metadata={
            "ticker": "AAPL",
            "company_name": "Apple Inc",
            "fiscal_year": 2025.0,  # Pinecone returns numbers as floats
            "fiscal_quarter": 3.0,
            "call_date": "2025-07-31",
            "speaker": "Tim Cook",
            "role": "CEO",
            "section": "qa",
            "chunk_index": float(i),
            "context_header": "AAPL (Apple Inc) · Q3 FY2025 earnings call",
            "text": f"chunk {i}",
        },
    )


CANDIDATES = [hit(i, 1.0 - i / 100) for i in range(10)]


def make_service(repo: FakeRepo | None = None, reranker: MagicMock | None = None):
    repo = repo or FakeRepo()
    repo.tickers.setdefault(
        "AAPL",
        TickerRecord(
            "AAPL", "indexed", "Apple Inc", 10, ["FY2025Q3"], indexed_at=utcnow()
        ),
    )
    store = MagicMock()
    store.query.return_value = CANDIDATES
    if reranker is None:
        reranker = MagicMock()
        reranker.rerank.return_value = [RerankedItem(7, 0.95), RerankedItem(2, 0.5)]
    pipeline = MagicMock()
    executor = InlineExecutor(run=False)
    coordinator = IngestionCoordinator(
        repo, pipeline, executor, daily_cap=8, stale_after=timedelta(minutes=30)
    )
    service = RagSearchService(
        repo,
        coordinator,
        FakeEmbedder(),
        FakeSparse(),
        store,
        reranker,
        rerank_cache=TTLCache(10, 60),
        namespace="ctx",
        candidate_k=25,
        alpha=0.75,
    )
    return service, store, reranker, executor


def test_build_filter_only_includes_given_fields() -> None:
    assert build_filter(RagFilters()) is None
    assert build_filter(RagFilters(ticker="AAPL", fiscal_quarter=3)) == {
        "ticker": {"$eq": "AAPL"},
        "fiscal_quarter": {"$eq": 3},
    }


def test_hybrid_scale_is_a_convex_combination() -> None:
    dense, sparse = hybrid_scale([1.0, 2.0], SparseVector([3], [4.0]), 0.75)

    assert dense == [0.75, 1.5]
    assert sparse == SparseVector([3], [1.0])
    with pytest.raises(ValueError):
        hybrid_scale([1.0], SparseVector([], []), 1.5)


def test_search_prefilters_reranks_and_returns_citations() -> None:
    service, store, reranker, _ = make_service()

    response = service.search(
        RagSearchRequest(
            query="services margin", ticker="aapl", fiscal_year=2025, top_k=2
        )
    )

    kwargs = store.query.call_args.kwargs
    assert kwargs["metadata_filter"] == {
        "ticker": {"$eq": "AAPL"},
        "fiscal_year": {"$eq": 2025},
    }
    assert kwargs["top_k"] == 25
    assert kwargs["sparse"] is not None
    assert kwargs["dense"] == pytest.approx([0.45, 0.6])  # alpha-scaled
    assert response.reranked is True
    assert response.candidate_count == 10
    assert [r.id for r in response.results] == [CANDIDATES[7].id, CANDIDATES[2].id]
    first = response.results[0]
    assert first.score == 0.95 and first.retrieval_score == CANDIDATES[7].score
    assert first.fiscal_year == 2025 and first.chunk_index == 7
    docs = reranker.rerank.call_args.args[1]
    assert docs[0].startswith("AAPL (Apple Inc)")  # header included for reranking


def test_rerank_failure_falls_back_to_hybrid_order(caplog) -> None:
    reranker = MagicMock()
    reranker.rerank.side_effect = RerankUnavailableError("quota exhausted")
    service, *_ = make_service(reranker=reranker)

    with caplog.at_level(logging.WARNING):
        response = service.search(RagSearchRequest(query="q", top_k=3))

    assert response.reranked is False
    assert [r.id for r in response.results] == [c.id for c in CANDIDATES[:3]]
    assert response.results[0].rerank_score is None
    assert "falling back" in caplog.text


def test_rerank_results_are_cached_for_repeated_queries() -> None:
    service, _, reranker, _ = make_service()

    service.search(RagSearchRequest(query="q"))
    service.search(RagSearchRequest(query="q"))

    assert reranker.rerank.call_count == 1


def test_dense_mode_skips_sparse_and_rerank() -> None:
    service, store, reranker, _ = make_service()

    response = service.retrieve(RagSearchRequest(query="q"), mode=RetrievalMode.DENSE)

    assert store.query.call_args.kwargs["sparse"] is None
    assert store.query.call_args.kwargs["dense"] == [0.6, 0.8]  # unscaled
    reranker.rerank.assert_not_called()
    assert response.reranked is False and len(response.results) == 5


def test_unindexed_ticker_starts_indexing_instead_of_searching() -> None:
    service, store, _, executor = make_service()

    response = service.search(RagSearchRequest(query="q", ticker="NVDA"))

    assert response.status == "indexing"
    assert response.ticker == "NVDA" and response.job_id
    assert response.poll_url == "/rag/tickers/NVDA"
    assert len(executor.submitted) == 1
    store.query.assert_not_called()


def test_upstream_failure_maps_to_search_error() -> None:
    service, store, *_ = make_service()
    store.query.side_effect = RuntimeError("pinecone down")

    with pytest.raises(SearchUpstreamError):
        service.search(RagSearchRequest(query="q"))


def test_search_logs_structured_fields(caplog) -> None:
    service, *_ = make_service()

    with caplog.at_level(logging.INFO, logger="app.services.rag.search"):
        service.search(RagSearchRequest(query="q", ticker="AAPL"))

    record = next(r for r in caplog.records if r.getMessage() == "rag search")
    payload = json.loads(JsonFormatter().format(record))
    assert payload["filters"] == {"ticker": "AAPL"}
    assert payload["candidate_count"] == 10
    assert "latency_ms" in payload and "rerank_ms" in payload
