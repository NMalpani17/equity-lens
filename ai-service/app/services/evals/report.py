"""Aggregate case results into per-model metrics and a Markdown table."""

import statistics
from collections import defaultdict
from dataclasses import dataclass

from .models import CaseResult, Category
from .pricing import model_id


@dataclass(frozen=True)
class ModelSummary:
    model: str
    cases: int
    passed: int
    faithfulness: float | None
    relevance: float | None
    completeness: float | None
    judge_wins: int
    judge_ties: int
    judged: int
    latency_p50: float
    latency_p95: float
    avg_input_tokens: float
    avg_output_tokens: float
    cost_per_turn: float
    total_cost: float
    by_category: dict[str, tuple[int, int]]  # category -> (passed, total)

    @property
    def pass_rate(self) -> float:
        return self.passed / self.cases if self.cases else 0.0


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 2) if values else None


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return ordered[index]


def summarize(results: list[CaseResult]) -> list[ModelSummary]:
    by_model: dict[str, list[CaseResult]] = defaultdict(list)
    for result in results:
        by_model[result.turn.model].append(result)
    summaries = []
    for model, items in by_model.items():
        judged = [r for r in items if r.judge is not None]
        categories: dict[Category, list[bool]] = defaultdict(list)
        for r in items:
            categories[r.case.category].append(r.passed)
        latencies = [r.turn.latency_s for r in items]
        total_cost = sum(r.cost_usd for r in items)
        summaries.append(
            ModelSummary(
                model=model,
                cases=len(items),
                passed=sum(r.passed for r in items),
                faithfulness=_mean([r.judge.faithfulness for r in judged]),
                relevance=_mean([r.judge.relevance for r in judged]),
                completeness=_mean([r.judge.completeness for r in judged]),
                judge_wins=sum(r.judge_preferred is True for r in judged),
                # A tie (or a lone answer) is judged but preferred by neither.
                judge_ties=sum(r.judge_preferred is None for r in judged),
                judged=len(judged),
                latency_p50=round(statistics.median(latencies), 1) if latencies else 0,
                latency_p95=round(_percentile(latencies, 0.95), 1),
                avg_input_tokens=round(
                    statistics.fmean([r.turn.input_tokens for r in items])
                )
                if items
                else 0,
                avg_output_tokens=round(
                    statistics.fmean([r.turn.output_tokens for r in items])
                )
                if items
                else 0,
                cost_per_turn=total_cost / len(items) if items else 0.0,
                total_cost=total_cost,
                by_category={
                    c: (sum(v), len(v)) for c, v in sorted(categories.items())
                },
            )
        )
    return summaries


def _fmt(value: float | None) -> str:
    return "–" if value is None else f"{value:.2f}"


def markdown_table(summaries: list[ModelSummary]) -> str:
    header = (
        "| Model | Checks passed | Faithfulness | Relevance | Completeness "
        "| Judge preferred | Latency p50 / p95 | Tokens in / out | Cost / turn |\n"
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    )
    rows = [
        f"| `{model_id(s.model)}` | {s.passed}/{s.cases} ({s.pass_rate:.0%}) "
        f"| {_fmt(s.faithfulness)} | {_fmt(s.relevance)} | {_fmt(s.completeness)} "
        f"| {s.judge_wins}/{s.judged} | {s.latency_p50:.1f}s / {s.latency_p95:.1f}s "
        f"| {s.avg_input_tokens:,.0f} / {s.avg_output_tokens:,.0f} "
        f"| ${s.cost_per_turn:.4f} |"
        for s in summaries
    ]
    return "\n".join([header, *rows])


def category_table(summaries: list[ModelSummary]) -> str:
    categories = sorted({c for s in summaries for c in s.by_category})
    header = (
        "| Category | " + " | ".join(f"`{model_id(s.model)}`" for s in summaries) + " |"
    )
    divider = "| --- |" + " --- |" * len(summaries)
    rows = []
    for category in categories:
        cells = []
        for s in summaries:
            passed, total = s.by_category.get(category, (0, 0))
            cells.append(f"{passed}/{total}")
        rows.append(f"| {category.replace('_', ' ')} | " + " | ".join(cells) + " |")
    return "\n".join([header, divider, *rows])
