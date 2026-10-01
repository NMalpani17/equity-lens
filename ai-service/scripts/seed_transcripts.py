"""Pre-seed the transcript index for a set of tickers.

Usage (from ai-service/):
    python -m scripts.seed_transcripts                 # the 10 default large caps
    python -m scripts.seed_transcripts AAPL MSFT       # specific tickers
    python -m scripts.seed_transcripts --force         # re-index from the DB cache
    python -m scripts.seed_transcripts --refresh       # re-fetch from Equibles
    python -m scripts.seed_transcripts --with-plain    # also build the eval namespace

Seeding bypasses the on-demand daily cap but still respects Equibles' quota:
each new ticker costs ~5 requests, and the run stops if the quota runs out.
Already-indexed tickers are skipped unless --force / --refresh is given.
"""

import argparse
import logging
import sys
from datetime import timedelta

from app.config import get_settings
from app.logging_config import configure_logging
from app.services.rag.container import build_components
from app.services.rag.repository import ClaimOutcome

DEFAULT_TICKERS = [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "GOOGL",
    "META",
    "TSLA",
    "JPM",
    "NFLX",
    "AMD",
]

logger = logging.getLogger("seed_transcripts")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tickers", nargs="*", default=DEFAULT_TICKERS)
    parser.add_argument(
        "--force", action="store_true", help="re-index tickers already indexed"
    )
    parser.add_argument(
        "--refresh", action="store_true", help="re-fetch transcripts from Equibles"
    )
    parser.add_argument(
        "--with-plain",
        action="store_true",
        help="also index header-less chunks for evaluation",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    settings = get_settings()
    configure_logging(settings.log_level)
    rag = build_components(settings)
    force = args.force or args.refresh or args.with_plain
    summary: list[tuple[str, str]] = []

    try:
        rag.store.ensure_index()
        for ticker in [t.strip().upper() for t in args.tickers]:
            claim = rag.repo.claim_ingestion(
                ticker,
                trigger="seed",
                daily_cap=None,
                stale_after=timedelta(minutes=settings.rag_stale_job_minutes),
                force=force,
            )
            if claim.outcome is not ClaimOutcome.STARTED or claim.job_id is None:
                summary.append((ticker, f"skipped ({claim.outcome.value})"))
                continue

            outcome = rag.coordinator.run_job(
                claim.job_id,
                ticker,
                refresh=args.refresh,
                include_plain=args.with_plain,
            )
            if outcome.succeeded and outcome.result:
                result = outcome.result
                summary.append(
                    (
                        ticker,
                        f"indexed {result.chunk_count} chunks "
                        f"({', '.join(result.quarters)})",
                    )
                )
            else:
                summary.append((ticker, f"failed: {outcome.error}"))
                if outcome.quota_exhausted:
                    logger.error("Equibles quota exhausted; stopping. Re-run tomorrow.")
                    break
    finally:
        rag.close()

    print("\nSeed summary")  # CLI output
    for ticker, status in summary:
        print(f"  {ticker:<6} {status}")
    return 0 if all(not s.startswith("failed") for _, s in summary) else 1


if __name__ == "__main__":
    sys.exit(main())
