"""Route tests for /rag using stubbed services (no external calls)."""

from collections.abc import Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.rag import (
    RagFilters,
    RagIndexingResponse,
    RagSearchResponse,
    RagSearchResult,
)
from app.services.rag.container import get_rag_components
from app.services.rag.errors import (
    IngestionCapReachedError,
    RagNotConfiguredError,
    TickerUnavailableError,
)
from app.services.rag.repository import TickerRecord, utcnow
from tests.rag_fakes import FakeRepo

RESULT = RagSearchResult(
    id="AAPL#FY2025Q3#0007",
    text="Services revenue hit an all-time record.",
    score=0.93,
    retrieval_score=0.71,
    rerank_score=0.93,
    ticker="AAPL",
    company_name="Apple Inc",
    fiscal_year=2025,
    fiscal_quarter=3,
    call_date="2025-07-31",
    speaker="Tim Cook",
    role="CEO",
    section="prepared_remarks",
    chunk_index=7,
    context_header="AAPL (Apple Inc) · Q3 FY2025 earnings call",
)


@pytest.fixture
def rag() -> Iterator[SimpleNamespace]:
    components = SimpleNamespace(search=MagicMock(), repo=FakeRepo())
    app.dependency_overrides[get_rag_components] = lambda: components
    yield components
    app.dependency_overrides.clear()


@pytest.fixture
def client(rag: SimpleNamespace) -> TestClient:
    return TestClient(app)


def test_search_returns_results(client: TestClient, rag: SimpleNamespace) -> None:
    rag.search.search.return_value = RagSearchResponse(
        query="services",
        filters=RagFilters(ticker="AAPL"),
        reranked=True,
        candidate_count=25,
        results=[RESULT],
        latency_ms=120.5,
    )

    res = client.post("/rag/search", json={"query": "services", "ticker": "aapl"})

    assert res.status_code == 200
    body = res.json()
    assert body["reranked"] is True
    assert body["results"][0]["speaker"] == "Tim Cook"
    request = rag.search.search.call_args.args[0]
    assert request.ticker == "AAPL" and request.top_k == 5


def test_search_returns_202_while_indexing(
    client: TestClient, rag: SimpleNamespace
) -> None:
    rag.search.search.return_value = RagIndexingResponse(
        ticker="NVDA", job_id="job-1", message="indexing", poll_url="/rag/tickers/NVDA"
    )

    res = client.post("/rag/search", json={"query": "q", "ticker": "NVDA"})

    assert res.status_code == 202
    assert res.json()["status"] == "indexing"
    assert res.json()["poll_url"] == "/rag/tickers/NVDA"


def test_search_maps_cap_error_to_429(client: TestClient, rag: SimpleNamespace) -> None:
    rag.search.search.side_effect = IngestionCapReachedError(
        "NVDA", 8, datetime(2026, 10, 1, tzinfo=UTC)
    )

    res = client.post("/rag/search", json={"query": "q", "ticker": "NVDA"})

    assert res.status_code == 429
    body = res.json()
    assert body["error"] == "ingestion_cap_reached"
    assert body["cap"] == 8 and body["resets_at"].startswith("2026-10-01")


def test_search_maps_unavailable_ticker_to_404(
    client: TestClient, rag: SimpleNamespace
) -> None:
    rag.search.search.side_effect = TickerUnavailableError("ZZZZ")

    res = client.post("/rag/search", json={"query": "q", "ticker": "ZZZZ"})

    assert res.status_code == 404
    assert res.json()["error"] == "transcripts_unavailable"


@pytest.mark.parametrize(
    "payload",
    [
        {"query": ""},
        {"query": "q", "top_k": 0},
        {"query": "q", "top_k": 21},
        {"query": "q", "fiscal_quarter": 5},
        {"query": "q", "ticker": "not a ticker"},
    ],
)
def test_search_validates_input(client: TestClient, payload: dict) -> None:
    res = client.post("/rag/search", json=payload)

    assert res.status_code == 422


def test_not_configured_returns_503() -> None:
    def raise_not_configured():
        raise RagNotConfiguredError(["AI_SERVICE_PINECONE_API_KEY"])

    app.dependency_overrides[get_rag_components] = raise_not_configured
    try:
        res = TestClient(app).post("/rag/search", json={"query": "q"})
    finally:
        app.dependency_overrides.clear()

    assert res.status_code == 503
    assert res.json()["missing"] == ["AI_SERVICE_PINECONE_API_KEY"]


def test_ticker_status_not_indexed(client: TestClient) -> None:
    res = client.get("/rag/tickers/msft")

    assert res.status_code == 200
    assert res.json() == {
        "ticker": "MSFT",
        "status": "not_indexed",
        "company_name": None,
        "chunk_count": 0,
        "quarters": [],
        "indexed_at": None,
        "last_error": None,
        "job": None,
    }


def test_ticker_status_includes_latest_job(
    client: TestClient, rag: SimpleNamespace
) -> None:
    claim = rag.repo.claim_ingestion(
        "NVDA", trigger="on_demand", daily_cap=8, stale_after=None
    )

    res = client.get("/rag/tickers/NVDA")

    body = res.json()
    assert body["status"] == "indexing"
    assert body["job"]["id"] == claim.job_id
    assert body["job"]["status"] == "queued"


def test_list_tickers(client: TestClient, rag: SimpleNamespace) -> None:
    rag.repo.tickers["AAPL"] = TickerRecord(
        "AAPL", "indexed", "Apple Inc", 120, ["FY2025Q3"], indexed_at=utcnow()
    )

    res = client.get("/rag/tickers")

    assert res.status_code == 200
    assert [t["ticker"] for t in res.json()["tickers"]] == ["AAPL"]
    assert res.json()["tickers"][0]["chunk_count"] == 120
