"""Evaluate the analyst agent end to end and compare chat models.

Usage (from ai-service/):
    python -m scripts.eval_chat --estimate        # cost estimate only, no API calls
    python -m scripts.eval_chat --yes             # run (spends Gemini credit)
    python -m scripts.eval_chat --yes --cases t01,pm01 --models MODEL[,MODEL]

Every case runs through the real agent (real tools, transcripts, Gemini) with
a fixed demo portfolio, then gets (a) deterministic checks and (b) a blind,
order-randomized LLM-judge rubric. Results print as Markdown tables and are
saved under scripts/eval/results/ (git-ignored). If Langfuse is configured,
each turn is traced (tagged "eval") and its scores are attached.

The judge is a Gemini Pro model when the whole run is estimated to cost less
than --budget (default $1.50), otherwise gemini-3.8-flash; --judge-model
overrides. On-demand indexing is disabled during the run (no Equibles quota
is spent) and the rerank cache is off so both models pay the same latency.
"""

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

from langchain.chat_models import init_chat_model

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.services.chat import mcp_server
from app.services.chat.agent import ChatService
from app.services.chat.context import turn_registry
from app.services.chat.service import build_chat_model
from app.services.evals.judge import llm_judge
from app.services.evals.models import CaseResult, EvalCase, TurnRecord
from app.services.evals.pricing import cost_usd, estimate, has_price, model_id
from app.services.evals.report import category_table, markdown_table, summarize
from app.services.evals.runner import EvalTracer, demo_portfolio, run_case
from app.services.evals.scoring import score_cases
from app.services.observability.tracing import (
    SCRIPT_SHUTDOWN_TIMEOUT_SECONDS,
    Tracer,
    build_tracer,
)
from app.services.rag.container import build_components

EVAL_DIR = Path(__file__).parent / "eval"
DEFAULT_CASES = EVAL_DIR / "chat_questions.json"
RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_MODELS = ["google_genai:gemini-3.8-flash", "google_genai:gemini-3.5-flash-lite"]
PRO_JUDGE = "google_genai:gemini-3.1-pro-preview"
FLASH_JUDGE = "google_genai:gemini-3.8-flash"
# The demo portfolio's prices are fixed; pin "today" next to its as-of date.
EVAL_TODAY = date(2026, 10, 2)

logger = logging.getLogger("eval_chat")


def load_cases(path: Path, only: list[str] | None = None) -> list[EvalCase]:
    cases = [EvalCase.model_validate(c) for c in json.loads(path.read_text())]
    return [c for c in cases if c.id in only] if only else cases


def choose_judge(cases: list[EvalCase], models: list[str], budget: float) -> str:
    """Pro if the whole run stays under budget, otherwise Flash."""
    pro = estimate(
        turns=len(cases),
        judged_questions=sum(c.judge for c in cases),
        models=models,
        judge_model=PRO_JUDGE,
    )
    return PRO_JUDGE if pro.total_usd < budget else FLASH_JUDGE


def print_estimates(cases: list[EvalCase], models: list[str], budget: float) -> None:
    judged = sum(c.judge for c in cases)
    print(f"{len(cases)} cases x {len(models)} models; {judged} judged questions\n")
    for judge in (PRO_JUDGE, FLASH_JUDGE):
        est = estimate(
            turns=len(cases), judged_questions=judged, models=models, judge_model=judge
        )
        agent = ", ".join(f"{model_id(m)} ${v:.2f}" for m, v in est.agent_usd.items())
        print(
            f"judge {model_id(judge)}: agent turns {agent}; "
            f"judge ${est.judge_usd:.2f}; total ${est.total_usd:.2f}"
        )
    chosen = model_id(choose_judge(cases, models, budget))
    print(f"\nSelected judge (budget ${budget:.2f}): {chosen}")


def eval_settings(base: Settings) -> Settings:
    """No ingestion of any kind, no rerank cache (fair latency across models).

    Both caps are zero: a new-ticker ingestion or a freshness refresh would
    spend Equibles quota and rewrite (and prune) the production index mid-run.
    """
    return base.model_copy(
        update={
            "rag_daily_ingestion_cap": 0,
            "rag_daily_refresh_cap": 0,
            "rag_query_cache_ttl_seconds": 0,
        }
    )


async def run_models(
    settings: Settings,
    cases: list[EvalCase],
    models: list[str],
    tracer: EvalTracer,
    run_id: str,
) -> dict[str, dict[str, TurnRecord]]:
    portfolio = demo_portfolio()
    turns: dict[str, dict[str, TurnRecord]] = {m: {} for m in models}
    for model in models:
        model_settings = settings.model_copy(update={"chat_model": model})
        service = ChatService(
            model_settings,
            lambda s=model_settings: build_chat_model(s),
            mcp_server.mcp,
            turn_registry,
            tracer=tracer,
        )
        for case in cases:
            turn = await run_case(
                service,
                tracer,
                case,
                model=model,
                portfolio=portfolio,
                today=EVAL_TODAY,
                trace_tags=["eval", f"eval-run:{run_id}", model_id(model)],
            )
            turns[model][case.id] = turn
            print(  # CLI progress
                f"  {model_id(model):<24} {case.id:<5} {turn.status:<9} "
                f"{turn.latency_s:>5.1f}s {','.join(turn.tool_names) or '-'}"
                + (f"  ERROR {turn.error}" if turn.error else "")
            )
    return turns


def log_scores(tracer: Tracer, results: list[CaseResult]) -> None:
    """Attach eval scores to each turn's Langfuse trace (if tracing is on)."""
    for r in results:
        trace_id = r.turn.trace_id
        failed = [c.name for c in r.checks if not c.passed]
        tracer.score(
            trace_id=trace_id,
            name="eval_checks_passed",
            value=1 if r.passed else 0,
            data_type="BOOLEAN",
            comment=f"failed: {', '.join(failed)}" if failed else None,
        )
        if r.judge:
            for name in ("faithfulness", "relevance", "completeness"):
                tracer.score(
                    trace_id=trace_id,
                    name=f"judge_{name}",
                    value=getattr(r.judge, name),
                    data_type="NUMERIC",
                    comment=r.judge.rationale if name == "faithfulness" else None,
                )
    tracer.flush()


def write_results(
    path: Path,
    results: list[CaseResult],
    *,
    run_id: str,
    judge_model: str,
    judge_cost: float,
    seed: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "run_id": run_id,
        "judge_model": judge_model,
        "judge_cost_usd": round(judge_cost, 4),
        "seed": seed,
        "results": [
            {
                **r.model_dump(mode="json", exclude={"case"}),
                "case_id": r.case.id,
                "category": r.case.category,
                "passed": r.passed,
            }
            for r in results
        ],
    }
    path.write_text(json.dumps(payload, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate the analyst chat agent.")
    parser.add_argument("--cases-file", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--cases", help="comma-separated case ids to run")
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS))
    parser.add_argument("--judge-model", help="override the automatic judge choice")
    parser.add_argument("--budget", type=float, default=1.50)
    parser.add_argument(
        "--no-judge", action="store_true", help="deterministic checks only"
    )
    parser.add_argument("--seed", type=int, default=7, help="judge label shuffling")
    parser.add_argument("--estimate", action="store_true", help="print cost and exit")
    parser.add_argument(
        "--yes", action="store_true", help="confirm spending API credit"
    )
    parser.add_argument("--json", type=Path, help="results path (default: results dir)")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    cases = load_cases(args.cases_file, args.cases.split(",") if args.cases else None)
    unpriced = [m for m in models if not has_price(m)]
    if unpriced:
        print(f"No price configured for {unpriced}; costs will show as $0.")
    if args.estimate or not args.yes:
        print_estimates(cases, models, args.budget)
        if not args.estimate:
            print("\nRe-run with --yes to spend the credit and run the eval.")
        return 0

    base = get_settings()
    configure_logging("WARNING")
    settings = eval_settings(base)
    judge_model = args.judge_model or choose_judge(cases, models, args.budget)
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    rag = build_components(settings)
    default_deps = mcp_server.default_tool_deps()
    mcp_server.set_tool_deps(
        lambda: replace(
            default_deps,
            search=lambda: rag.search,
            ticker_record=rag.repo.get_ticker,
            index_wait_seconds=0,
        )
    )
    tracer = EvalTracer(build_tracer(base))
    print(
        f"run {run_id}: {len(cases)} cases x {len(models)} models, judge "
        f"{'off' if args.no_judge else model_id(judge_model)}, tracing "
        f"{'on' if tracer.enabled else 'off'}"
    )
    judge = None
    if not args.no_judge:
        judge = llm_judge(
            init_chat_model(
                judge_model,
                api_key=base.gemini_api_key,
                thinking_level="low",
                max_tokens=4096,
                timeout=120,
                max_retries=2,
            )
        )

    async def run_and_score():
        # One event loop for both phases, so model clients close cleanly.
        turns = await run_models(settings, cases, models, tracer, run_id)
        return await score_cases(cases, turns, judge, seed=args.seed)

    try:
        results, judge_tokens = asyncio.run(run_and_score())
        log_scores(tracer, results)
    finally:
        rag.close()
        tracer.shutdown(SCRIPT_SHUTDOWN_TIMEOUT_SECONDS)

    judge_cost = cost_usd(judge_model, *judge_tokens) if not args.no_judge else 0.0
    summaries = summarize(results)
    agent_cost = sum(r.cost_usd for r in results)
    print("\n" + markdown_table(summaries))
    print("\nDeterministic checks by category:\n")
    print(category_table(summaries))
    total = agent_cost + judge_cost
    print(
        f"\nCost: agent ${agent_cost:.3f} + judge ${judge_cost:.3f} "
        f"({judge_tokens[0]:,} in / {judge_tokens[1]:,} out) = ${total:.3f}"
    )
    failures = [r for r in results if not r.passed]
    if failures:
        print("\nFailed checks:")
        for r in failures:
            failed = "; ".join(
                f"{c.name} ({c.detail})" for c in r.checks if not c.passed
            )
            print(f"  {model_id(r.turn.model):<24} {r.case.id:<5} {failed}")
    out = args.json or RESULTS_DIR / f"chat-{run_id}.json"
    write_results(
        out,
        results,
        run_id=run_id,
        judge_model=judge_model,
        judge_cost=judge_cost,
        seed=args.seed,
    )
    print(f"\nSaved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
