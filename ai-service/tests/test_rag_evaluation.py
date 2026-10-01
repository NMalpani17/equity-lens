"""Tests for the retrieval evaluation metrics and harness."""

from unittest.mock import MagicMock

import pytest

from app.models.rag import RagFilters, RagSearchResponse, RagSearchResult
from app.services.rag.evaluation import (
    ConfigReport,
    EvalConfig,
    EvalQuestion,
    ExpectedCall,
    default_configs,
    evaluate,
    first_relevant_rank,
    format_report,
)
from app.services.rag.search import RetrievalMode


def result(ticker: str, fy: int, fq: int) -> RagSearchResult:
    return RagSearchResult(
        id=f"{ticker}#{fy}{fq}",
        text="t",
        score=1,
        retrieval_score=1,
        ticker=ticker,
        company_name=ticker,
        fiscal_year=fy,
        fiscal_quarter=fq,
        speaker="s",
        section="qa",
        chunk_index=0,
        context_header="h",
    )


def question(qid: str, kind: str = "exact") -> EvalQuestion:
    return EvalQuestion(
        id=qid,
        query=f"query {qid}",
        kind=kind,
        expected=ExpectedCall(ticker="AAPL", fiscal_year=2025, fiscal_quarter=3),
    )


def test_first_relevant_rank_requires_matching_quarter() -> None:
    expected = ExpectedCall(ticker="AAPL", fiscal_year=2025, fiscal_quarter=3)
    results = [
        result("AAPL", 2025, 2),
        result("MSFT", 2025, 3),
        result("AAPL", 2025, 3),
    ]

    assert first_relevant_rank(results, expected) == 3
    assert first_relevant_rank(results[:2], expected) is None


def test_hit_rate_and_mrr() -> None:
    report = ConfigReport(
        EvalConfig("x", RetrievalMode.DENSE, "ns", True),
        ranks={"a": 1, "b": 2, "c": None, "d": 4},
    )

    assert report.hit_rate() == pytest.approx(0.75)
    assert report.mrr() == pytest.approx((1 + 0.5 + 0 + 0.25) / 4)


def test_default_configs_cover_modes_with_and_without_headers() -> None:
    configs = default_configs("ctx", "plain")

    assert len(configs) == 6
    assert {(c.mode, c.with_header) for c in configs} == {
        (mode, header) for mode in RetrievalMode for header in (True, False)
    }
    assert all((c.namespace == "ctx") == c.with_header for c in configs)


def test_evaluate_runs_each_config_and_counts_rerank_fallbacks() -> None:
    search = MagicMock()
    search.retrieve.return_value = RagSearchResponse(
        query="q",
        filters=RagFilters(),
        reranked=False,
        candidate_count=2,
        results=[result("MSFT", 2025, 3), result("AAPL", 2025, 3)],
        latency_ms=1,
    )
    questions = [question("a"), question("b", "conceptual")]
    configs = default_configs("ctx", "plain")

    reports = evaluate(search, questions, configs, k=5)

    assert search.retrieve.call_count == 12
    assert all(r.ranks == {"a": 2, "b": 2} for r in reports)
    rerank_reports = [
        r for r in reports if r.config.mode is RetrievalMode.HYBRID_RERANK
    ]
    assert all(r.rerank_fallbacks == 2 for r in rerank_reports)
    table = format_report(reports, questions, 5)
    assert "hybrid_rerank · headers" in table and "rerank fallbacks" in table
