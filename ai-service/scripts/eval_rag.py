"""Evaluate retrieval quality on the labeled question set.

Usage (from ai-service/):
    python -m scripts.eval_rag --build-plain   # first run: index header-less copies
    python -m scripts.eval_rag                 # report hit rate@5 and MRR
    python -m scripts.eval_rag --json out.json

Compares dense-only, hybrid, and hybrid+rerank, each with and without context
headers (the header-less variant lives in its own Pinecone namespace, built
from the Postgres transcript cache, so no Equibles quota is spent).

Cost: each run makes ~2 reranker calls per question (Pinecone Starter allows
500/month for bge-reranker-v2-m3).
"""

import argparse
import json
import logging
import sys
from pathlib import Path

from app.config import get_settings
from app.logging_config import configure_logging
from app.services.rag.container import build_components
from app.services.rag.evaluation import (
    EvalQuestion,
    default_configs,
    evaluate,
    format_report,
)

DEFAULT_QUESTIONS = Path(__file__).parent / "eval" / "questions.json"

logger = logging.getLogger("eval_rag")


def load_questions(path: Path) -> list[EvalQuestion]:
    return [EvalQuestion.model_validate(q) for q in json.loads(path.read_text())]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate transcript retrieval.")
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument(
        "--build-plain",
        action="store_true",
        help="index header-less chunks for every indexed ticker first",
    )
    parser.add_argument("--json", type=Path, help="also write results as JSON")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    settings = get_settings()
    configure_logging(settings.log_level)
    questions = load_questions(args.questions)
    rag = build_components(settings)
    try:
        if args.build_plain:
            for record in rag.repo.list_tickers():
                if record.status == "indexed":
                    rag.pipeline.ingest(record.ticker, cache_only=True, plain_only=True)

        configs = default_configs(
            settings.pinecone_namespace, settings.pinecone_plain_namespace
        )
        reports = evaluate(rag.search, questions, configs, k=args.k)
    finally:
        rag.close()

    print(f"\n{len(questions)} questions, k={args.k}\n")  # CLI output
    print(format_report(reports, questions, args.k))
    if args.json:
        args.json.write_text(
            json.dumps(
                [
                    {
                        "config": r.config.name,
                        "hit_rate": r.hit_rate(),
                        "mrr": r.mrr(),
                        "rerank_fallbacks": r.rerank_fallbacks,
                        "ranks": r.ranks,
                    }
                    for r in reports
                ],
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
