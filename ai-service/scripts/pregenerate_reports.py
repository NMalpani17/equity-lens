"""Pre-generate research reports for the demo tickers.

Usage (from ai-service/):
    python -m scripts.pregenerate_reports              # plan + cost estimate only
    python -m scripts.pregenerate_reports --yes        # generate and save
    python -m scripts.pregenerate_reports --yes --tickers NVDA
    python -m scripts.pregenerate_reports --yes --force   # even if under 7 days old

Without --yes nothing is contacted: no database, no models, no Pinecone. With
--yes each ticker runs the same multi-agent pipeline as the app and saves to
research_reports (production: local settings point at it), so run it only
after the migration that creates the table has been applied by CD. A ticker
whose report for its latest quarter is under 7 days old is skipped unless
--force; one that isn't indexed is refused before any model call. The run
stops before the next report once the actual spend reaches --max-cost.
"""

import argparse
import asyncio
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.models.report import ReportRequest
from app.services.evals.pricing import ReportEstimate, estimate_reports

# The demo portfolio's tickers that have earnings calls (VOO is an ETF);
# keep in sync with api/src/services/demoHoldings.ts.
DEMO_TICKERS = ("AAPL", "MSFT", "NVDA", "TSLA")
# The requester in traces (hashed there) for reports nobody asked for.
SCRIPT_USER = "system:pregenerate"
DEFAULT_MAX_COST = 1.00


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tickers", nargs="+", default=list(DEMO_TICKERS))
    parser.add_argument("--yes", action="store_true", help="generate (writes reports)")
    parser.add_argument(
        "--force", action="store_true", help="regenerate reports under 7 days old"
    )
    parser.add_argument(
        "--max-cost",
        type=float,
        default=DEFAULT_MAX_COST,
        help="stop once actual spend reaches this many USD "
        f"(default {DEFAULT_MAX_COST:.2f})",
    )
    args = parser.parse_args(argv)
    args.tickers = list(dict.fromkeys(t.strip().upper() for t in args.tickers))
    return args


def print_estimate(estimate: ReportEstimate, tickers: Sequence[str]) -> None:
    print(f"Reports: {estimate.reports} ({', '.join(tickers)})")  # CLI output
    print("Per report (USD):          typical   at most")
    for agent in ("transcripts", "market", "writer"):
        print(
            f"  {agent:<12} {estimate.models[agent]:<22}"
            f"{estimate.typical_usd[agent]:>8.4f}  {estimate.most_usd[agent]:>8.4f}"
        )
    print(
        f"  {'total':<35}{sum(estimate.typical_usd.values()):>8.4f}"
        f"  {sum(estimate.most_usd.values()):>8.4f}"
    )
    print(
        f"All reports: ~${estimate.typical_total:.2f} typical, "
        f"${estimate.most_total:.2f} at most (every agent at its step and output "
        "limits)"
    )
    print(
        f"Pinecone reranks: at most {estimate.reranks_max} "
        "(Starter allows 500 a month); Equibles: none (indexed tickers only)."
    )


@dataclass
class Outcome:
    ticker: str
    status: str
    detail: str = ""
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0


async def generate(
    service, ticker: str, *, force: bool, log: Callable[[str], None]
) -> Outcome:
    request = ReportRequest(
        user_id=SCRIPT_USER, ticker=ticker, regenerate_after_days=0 if force else 7
    )
    async for event in service.stream(request, trace_tags=("pregenerate",)):
        if event.type == "agent":
            data = event.data
            summary = f" · {data['summary']}" if data.get("summary") else ""
            line = f"  {ticker} {data['agent']:<11} {data['state']:<7} {data['label']}"
            log(line + summary)
        elif event.type == "done":
            usage = event.data["usage"]
            return Outcome(
                ticker,
                "generated",
                f"Q{event.data['fiscal_quarter']} FY{event.data['fiscal_year']}",
                usage["cost_usd"],
                usage["input_tokens"],
                usage["output_tokens"],
            )
        elif event.type == "error":
            code = event.data["code"]
            status = (
                "skipped"
                if code in ("report_fresh", "report_in_progress")
                else "failed"
            )
            return Outcome(ticker, status, f"{code}: {event.data['message']}")
    return Outcome(ticker, "failed", "stream ended without a result")


def default_service():
    from app.services.report.service import get_report_service

    return get_report_service()


def shutdown() -> None:
    from app.services.observability.tracing import (
        SCRIPT_SHUTDOWN_TIMEOUT_SECONDS,
        shutdown_tracer,
    )
    from app.services.rag.container import shutdown_rag_components

    # Upload every span before exiting (it flushes, waiting up to 30 s).
    shutdown_tracer(SCRIPT_SHUTDOWN_TIMEOUT_SECONDS)
    shutdown_rag_components()


async def run(
    args: argparse.Namespace,
    service,
    *,
    log: Callable[[str], None] = print,
) -> list[Outcome]:
    outcomes: list[Outcome] = []
    for ticker in args.tickers:
        spent = sum(o.cost_usd for o in outcomes)
        if spent >= args.max_cost:
            outcomes.append(
                Outcome(ticker, "not run", f"budget ${args.max_cost:.2f} reached")
            )
            continue
        outcome = await generate(service, ticker, force=args.force, log=log)
        log(f"{ticker}: {outcome.status} {outcome.detail}".rstrip())
        outcomes.append(outcome)
    return outcomes


def print_summary(outcomes: Sequence[Outcome]) -> None:
    print("\nSummary")  # CLI output
    for o in outcomes:
        cost = f"${o.cost_usd:.4f} ({o.input_tokens:,} in / {o.output_tokens:,} out)"
        print(f"  {o.ticker:<6} {o.status:<10} {cost if o.cost_usd else ''} {o.detail}")
    print(f"Actual spend: ${sum(o.cost_usd for o in outcomes):.4f}")


def main(
    argv: Sequence[str] | None = None,
    *,
    settings: Settings | None = None,
    service_factory: Callable[[], object] = default_service,
) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    settings = settings or get_settings()
    print_estimate(estimate_reports(settings, len(args.tickers)), args.tickers)
    if not args.yes:
        print("\nEstimate only: nothing was contacted. Re-run with --yes to generate.")
        return 0

    configure_logging(settings.log_level)
    print("\nGenerating (saves to research_reports)…")
    try:
        outcomes = asyncio.run(run(args, service_factory()))
    finally:
        if service_factory is default_service:
            shutdown()
    print_summary(outcomes)
    return 1 if any(o.status in ("failed", "not run") for o in outcomes) else 0


if __name__ == "__main__":
    sys.exit(main())
