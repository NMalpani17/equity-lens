"""Retrieval evaluation: hit rate@k and MRR across retrieval configurations.

A result counts as relevant when it comes from the expected ticker and fiscal
quarter, so the metrics measure whether retrieval lands on the right call.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

from app.models.rag import RagSearchRequest, RagSearchResult

from .search import RagSearchService, RetrievalMode


class ExpectedCall(BaseModel):
    ticker: str
    fiscal_year: int
    fiscal_quarter: int


class EvalQuestion(BaseModel):
    id: str
    query: str
    kind: Literal["exact", "conceptual"]
    expected: ExpectedCall
    # Optional filters applied to the search (most questions are unfiltered).
    ticker: str | None = None
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None


@dataclass(frozen=True)
class EvalConfig:
    name: str
    mode: RetrievalMode
    namespace: str
    with_header: bool


@dataclass
class ConfigReport:
    config: EvalConfig
    ranks: dict[str, int | None] = field(default_factory=dict)
    rerank_fallbacks: int = 0

    def hit_rate(self, questions: Sequence[EvalQuestion] | None = None) -> float:
        ranks = self._ranks_for(questions)
        return sum(r is not None for r in ranks) / len(ranks) if ranks else 0.0

    def mrr(self, questions: Sequence[EvalQuestion] | None = None) -> float:
        ranks = self._ranks_for(questions)
        return sum(1 / r for r in ranks if r) / len(ranks) if ranks else 0.0

    def _ranks_for(self, questions: Sequence[EvalQuestion] | None) -> list[int | None]:
        if questions is None:
            return list(self.ranks.values())
        return [self.ranks[q.id] for q in questions if q.id in self.ranks]


def first_relevant_rank(
    results: Sequence[RagSearchResult], expected: ExpectedCall
) -> int | None:
    """1-based rank of the first result from the expected call, else None."""
    for rank, result in enumerate(results, start=1):
        if (
            result.ticker == expected.ticker
            and result.fiscal_year == expected.fiscal_year
            and result.fiscal_quarter == expected.fiscal_quarter
        ):
            return rank
    return None


def default_configs(context_namespace: str, plain_namespace: str) -> list[EvalConfig]:
    """Dense / hybrid / hybrid+rerank, each with and without context headers."""
    configs = []
    for with_header, namespace, label in (
        (False, plain_namespace, "no headers"),
        (True, context_namespace, "headers"),
    ):
        for mode in RetrievalMode:
            configs.append(
                EvalConfig(f"{mode.value} · {label}", mode, namespace, with_header)
            )
    return configs


def evaluate(
    search: RagSearchService,
    questions: Sequence[EvalQuestion],
    configs: Sequence[EvalConfig],
    *,
    k: int = 5,
) -> list[ConfigReport]:
    reports = []
    for config in configs:
        report = ConfigReport(config)
        for question in questions:
            response = search.retrieve(
                RagSearchRequest(
                    query=question.query,
                    ticker=question.ticker,
                    fiscal_year=question.fiscal_year,
                    fiscal_quarter=question.fiscal_quarter,
                    top_k=k,
                ),
                mode=config.mode,
                namespace=config.namespace,
                with_header=config.with_header,
            )
            if config.mode is RetrievalMode.HYBRID_RERANK and not response.reranked:
                report.rerank_fallbacks += 1
            report.ranks[question.id] = first_relevant_rank(
                response.results, question.expected
            )
        reports.append(report)
    return reports


def format_report(
    reports: Sequence[ConfigReport], questions: Sequence[EvalQuestion], k: int
) -> str:
    """Plain-text table: overall, exact-term and conceptual metrics per config."""
    exact = [q for q in questions if q.kind == "exact"]
    conceptual = [q for q in questions if q.kind == "conceptual"]
    header = (
        f"{'config':<30} {'hit@' + str(k):>7} {'MRR':>6}  "
        f"{'exact hit/MRR':>14}  {'concept hit/MRR':>16}"
    )
    lines = [header, "-" * len(header)]
    for report in reports:
        line = (
            f"{report.config.name:<30} {report.hit_rate():>7.2f} {report.mrr():>6.2f}  "
            f"{report.hit_rate(exact):>6.2f}/{report.mrr(exact):<7.2f}  "
            f"{report.hit_rate(conceptual):>7.2f}/{report.mrr(conceptual):<8.2f}"
        )
        if report.rerank_fallbacks:
            line += f"  ({report.rerank_fallbacks} rerank fallbacks)"
        lines.append(line)
    return "\n".join(lines)
