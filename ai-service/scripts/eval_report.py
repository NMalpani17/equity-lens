"""Evaluate the multi-agent research report on a few tickers.

Usage (from ai-service/):
    python -m scripts.eval_report                  # cost estimate only
    python -m scripts.eval_report --yes            # run (spends Gemini credit)
    python -m scripts.eval_report --yes --tickers NVDA --no-judge

Each ticker's report is generated in-process by the same pipeline as the app
(real agents, transcripts, market data, Gemini) but never saved: the claim
store is in memory, so research_reports is not touched. New-ticker ingestion
and freshness refresh are off (no Equibles quota, the index is never
rewritten). Every report gets the deterministic checks in
app/services/evals/report_checks.py and, unless --no-judge, a rubric score
from a Gemini Pro judge that sees the report with its cited passages and
market data. Results print as a Markdown table and are saved under
scripts/eval/results/ (git-ignored); with Langfuse configured each report is
one trace tagged "eval", with the scores attached.
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langchain.chat_models import init_chat_model

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.models.report import ReportRequest, ResearchReportContent
from app.services.evals.judge import JudgeCall, llm_judge
from app.services.evals.models import CheckResult, JudgeScore
from app.services.evals.pricing import cost_usd, estimate_reports, model_id
from app.services.evals.report_checks import (
    judge_evidence,
    report_markdown,
    run_report_checks,
)
from app.services.rag.repository import utcnow
from app.services.report.repository import Claim, ClaimOutcome

EVAL_DIR = Path(__file__).parent / "eval"
RESULTS_DIR = EVAL_DIR / "results"
# Large caps with four indexed quarters and different fiscal calendars.
DEFAULT_TICKERS = ("NVDA", "AAPL", "MSFT")
PRO_JUDGE = "google_genai:gemini-3.1-pro-preview"
# One judge call per report: the report plus its cited passages and data.
EST_JUDGE_TOKENS = (12_000, 1_500)
MAX_JUDGE_TOKENS = (20_000, 4_096)
EVAL_USER = "system:eval"

logger = logging.getLogger("eval_report")

JUDGE_TASK = (
    "Grade this equity research report. It has six sections (summary, demand "
    "and business drivers, guidance and outlook, what changed vs the previous "
    "quarter, stock performance, risks). Faithfulness: every claim and number "
    "is supported by the cited passages or market data; any invented figure or "
    "a claim stronger than its source caps it at 2. Relevance: it stays on the "
    "company's latest call and price performance, without padding. "
    "Completeness: it covers what the evidence supports for each section."
)


class EvalReportRepository:
    """Claims always succeed and nothing is stored: evals never write reports."""

    def claim(self, ticker: str, fiscal_year: int, fiscal_quarter: int, **_: Any):
        return Claim(
            ClaimOutcome.CLAIMED, f"eval-{ticker}-{fiscal_year}Q{fiscal_quarter}"
        )

    def save(self, generation_id: str, **_: Any) -> datetime:
        return utcnow()

    def release(self, generation_id: str) -> None:
        return None


@dataclass
class ReportResult:
    ticker: str
    status: str = "error"
    error: str | None = None
    quarter: str | None = None
    checks: list[CheckResult] = field(default_factory=list)
    judge: JudgeScore | None = None
    report_cost_usd: float = 0.0
    judge_cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    latency_s: float = 0.0
    trace_id: str | None = None
    report: dict[str, Any] | None = None

    @property
    def passed(self) -> bool:
        return self.status == "complete" and all(c.passed for c in self.checks)


def print_estimate(settings: Settings, tickers: list[str], *, judge: bool) -> None:
    reports = estimate_reports(settings, len(tickers))
    judge_typical = cost_usd(PRO_JUDGE, *EST_JUDGE_TOKENS) * len(tickers)
    judge_most = cost_usd(PRO_JUDGE, *MAX_JUDGE_TOKENS) * len(tickers)
    print(f"Reports: {len(tickers)} ({', '.join(tickers)}), never saved")  # CLI output
    print(
        f"  reports: ~${reports.typical_total:.2f} typical, "
        f"${reports.most_total:.2f} at most"
    )
    if judge:
        print(
            f"  judge {model_id(PRO_JUDGE)}: ~${judge_typical:.2f} typical, "
            f"${judge_most:.2f} at most"
        )
    total = reports.typical_total + (judge_typical if judge else 0)
    most = reports.most_total + (judge_most if judge else 0)
    print(f"Total: ~${total:.2f} typical, ${most:.2f} at most")
    print(
        f"Pinecone reranks: at most {reports.reranks_max}; Equibles: none "
        "(ingestion and freshness refresh are off)."
    )


def build_judge_prompt(report: ResearchReportContent) -> str:
    evidence = judge_evidence(report)
    passages = "\n\n".join(
        f"[{c['id']}] {c['ticker']} Q{c['fiscal_quarter']} FY{c['fiscal_year']}, "
        f"{c['speaker']}: {c['text']}"
        for c in evidence["citations"]
    )
    data = "\n".join(json.dumps(d, default=str) for d in evidence["data"])
    return (
        f"QUESTION:\n{JUDGE_TASK}\n\n### Answer A\n{report_markdown(report)}\n\n"
        f"#### Evidence available to Answer A\n{passages or '(no passages)'}\n\n"
        f"Market data:\n{data or '(none: price data unavailable)'}"
    )


async def judge_report(
    call: JudgeCall, report: ResearchReportContent
) -> tuple[JudgeScore | None, tuple[int, int]]:
    verdict, tokens = await call(build_judge_prompt(report))
    answer = next((a for a in verdict.answers if a.label.strip().upper() == "A"), None)
    if answer is None:
        return None, tokens
    return (
        JudgeScore(
            faithfulness=answer.faithfulness,
            relevance=answer.relevance,
            completeness=answer.completeness,
            rationale=answer.rationale,
        ),
        tokens,
    )


async def evaluate(
    service: Any,
    tickers: list[str],
    judge: JudgeCall | None,
    *,
    judge_model: str = PRO_JUDGE,
    log=print,
) -> list[ReportResult]:
    results = []
    for ticker in tickers:
        result = ReportResult(ticker=ticker)
        started = time.perf_counter()
        request = ReportRequest(
            user_id=EVAL_USER, ticker=ticker, regenerate_after_days=0
        )
        async for event in service.stream(request, trace_tags=("eval",)):
            if event.type == "agent":
                log(f"  {ticker} {event.data['agent']:<11} {event.data['state']}")
            elif event.type == "done":
                result.status = "complete"
                result.report = event.data["report"]
                result.trace_id = event.data.get("trace_id")
                usage = event.data["usage"]
                result.report_cost_usd = usage["cost_usd"]
                result.input_tokens = usage["input_tokens"]
                result.output_tokens = usage["output_tokens"]
            elif event.type == "error":
                result.error = f"{event.data['code']}: {event.data['message']}"
        result.latency_s = round(time.perf_counter() - started, 1)
        if result.report is not None:
            content = ResearchReportContent.model_validate(result.report)
            result.quarter = (
                f"Q{content.quarter.fiscal_quarter} FY{content.quarter.fiscal_year}"
            )
            result.checks = run_report_checks(content)
            if judge is not None:
                try:
                    result.judge, (tin, tout) = await judge_report(judge, content)
                    result.judge_cost_usd = cost_usd(judge_model, tin, tout)
                except Exception as exc:  # a judge failure doesn't lose the report
                    logger.warning("judge failed for %s: %s", ticker, exc)
        log(f"{ticker}: {result.status} {result.error or ''}".rstrip())
        results.append(result)
    return results


def results_table(results: list[ReportResult]) -> str:
    lines = [
        "| Ticker | Quarter | Checks | Failed | Faith. | Rel. | Compl. "
        "| Cost | Latency |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        passed = sum(c.passed for c in r.checks)
        failed = ", ".join(c.name for c in r.checks if not c.passed) or (r.error or "—")
        j = r.judge
        lines.append(
            f"| {r.ticker} | {r.quarter or '—'} | {passed}/{len(r.checks)} "
            f"| {failed} | "
            f"{j.faithfulness if j else '—'} | {j.relevance if j else '—'} | "
            f"{j.completeness if j else '—'} | "
            f"${r.report_cost_usd + r.judge_cost_usd:.4f} | {r.latency_s}s |"
        )
    total = sum(r.report_cost_usd + r.judge_cost_usd for r in results)
    lines.append(f"\nTotal cost: ${total:.4f}")
    return "\n".join(lines)


def record_scores(tracer: Any, results: list[ReportResult]) -> None:
    for r in results:
        if not r.trace_id:
            continue
        tracer.score(
            trace_id=r.trace_id,
            name="report_checks_passed",
            value=1.0 if r.passed else 0.0,
            data_type="BOOLEAN",
        )
        if r.judge:
            for name in ("faithfulness", "relevance", "completeness"):
                tracer.score(
                    trace_id=r.trace_id,
                    name=name,
                    value=float(getattr(r.judge, name)),
                    data_type="NUMERIC",
                    comment=r.judge.rationale if name == "faithfulness" else None,
                )
    tracer.flush()


def rescore(path: Path) -> int:
    """Re-run the checks on a saved run's reports; judge scores are kept."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    results = []
    for saved in payload["results"]:
        result = ReportResult(
            ticker=saved["ticker"],
            status=saved["status"],
            error=saved.get("error"),
            quarter=saved.get("quarter"),
            judge=JudgeScore(**saved["judge"]) if saved.get("judge") else None,
            report_cost_usd=saved.get("report_cost_usd", 0.0),
            judge_cost_usd=saved.get("judge_cost_usd", 0.0),
            latency_s=saved.get("latency_s", 0.0),
            report=saved.get("report"),
        )
        if result.report is not None:
            content = ResearchReportContent.model_validate(result.report)
            result.checks = run_report_checks(content)
        saved["checks"] = [c.model_dump() for c in result.checks]
        saved["passed"] = result.passed
        results.append(result)
    payload["rescored_at"] = datetime.now(UTC).isoformat()
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    print(results_table(results))  # CLI output
    print(f"Rescored {path}")
    return 0 if all(r.passed for r in results) else 1


def eval_report_settings(base: Settings) -> Settings:
    """No ingestion or freshness refresh during the eval."""
    return base.model_copy(
        update={"rag_daily_ingestion_cap": 0, "rag_daily_refresh_cap": 0}
    )


def build_service(settings: Settings, tracer: Any):
    from app.services.chat import mcp_server
    from app.services.chat.context import turn_registry
    from app.services.rag.container import build_components
    from app.services.report.service import ReportService, default_agents

    rag = build_components(settings)
    deps = mcp_server.default_tool_deps()
    mcp_server.set_tool_deps(
        lambda: replace(
            deps,
            search=lambda: rag.search,
            comparison=lambda: rag.comparison,
            ticker_record=rag.repo.get_ticker,
            index_wait_seconds=0,
        )
    )
    service = ReportService(
        settings,
        default_agents(settings),
        mcp_server.mcp,
        turn_registry,
        repo=lambda: EvalReportRepository(),
        ticker_record=rag.repo.get_ticker,
        tracer=tracer,
    )
    return service, rag


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the research report.")
    parser.add_argument("--tickers", default=",".join(DEFAULT_TICKERS))
    parser.add_argument("--no-judge", action="store_true", help="checks only")
    parser.add_argument("--yes", action="store_true", help="spend the API credit")
    parser.add_argument("--json", type=Path, help="results path")
    parser.add_argument(
        "--rescore",
        type=Path,
        metavar="RESULTS_JSON",
        help="re-run the deterministic checks on saved reports (no API calls)",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if args.rescore:
        return rescore(args.rescore)

    base = get_settings()
    print_estimate(base, tickers, judge=not args.no_judge)
    if not args.yes:
        print("\nEstimate only: nothing was contacted. Re-run with --yes to run.")
        return 0

    from app.services.observability.tracing import build_tracer

    configure_logging("WARNING")
    settings = eval_report_settings(base)
    tracer = build_tracer(base)
    service, rag = build_service(settings, tracer)
    judge = None
    if not args.no_judge:
        judge = llm_judge(
            init_chat_model(
                PRO_JUDGE,
                api_key=base.gemini_api_key,
                thinking_level="low",
                max_tokens=MAX_JUDGE_TOKENS[1],
                timeout=120,
                max_retries=2,
            )
        )
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    try:
        results = asyncio.run(evaluate(service, tickers, judge))
        record_scores(tracer, results)
    finally:
        rag.close()
        tracer.shutdown(timeout=5)
    print("\n" + results_table(results))
    path = args.json or RESULTS_DIR / f"report-{run_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "judge_model": None if args.no_judge else model_id(PRO_JUDGE),
                "results": [
                    {
                        **{
                            k: v
                            for k, v in r.__dict__.items()
                            if k not in ("checks", "judge")
                        },
                        "checks": [c.model_dump() for c in r.checks],
                        "judge": r.judge.model_dump() if r.judge else None,
                        "passed": r.passed,
                    }
                    for r in results
                ],
            },
            indent=2,
            default=str,
        )
    )
    print(f"Saved {path}")
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
