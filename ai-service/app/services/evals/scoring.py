"""Combine deterministic checks, judge scores and cost into case results."""

import logging

from .checks import run_checks
from .judge import JudgeCall, judge_case
from .models import CaseResult, EvalCase, TurnRecord
from .pricing import cost_usd

logger = logging.getLogger(__name__)


async def score_cases(
    cases: list[EvalCase],
    turns: dict[str, dict[str, TurnRecord]],
    judge: JudgeCall | None,
    *,
    seed: int = 7,
) -> tuple[list[CaseResult], tuple[int, int]]:
    """Score every model's turn on every case.

    ``turns`` maps model -> case id -> turn. Returns the results and the
    judge's total (input, output) tokens. A judge failure on one case leaves
    that case unjudged rather than failing the run.
    """
    results: list[CaseResult] = []
    judge_tokens = [0, 0]
    for case in cases:
        case_turns = {
            m: by_case[case.id] for m, by_case in turns.items() if case.id in by_case
        }
        judgement = None
        judgeable = {m: t for m, t in case_turns.items() if not t.error}
        if judge is not None and case.judge and judgeable:
            try:
                judgement = await judge_case(judge, case, judgeable, seed=seed)
                judge_tokens[0] += judgement.input_tokens
                judge_tokens[1] += judgement.output_tokens
            except Exception as exc:
                logger.warning("judge failed on %s: %s", case.id, exc)
        for model, turn in case_turns.items():
            score = judgement.scores.get(model) if judgement else None
            preferred = None
            if judgement and score and judgement.preferred_model:
                preferred = judgement.preferred_model == model
            results.append(
                CaseResult(
                    case=case,
                    turn=turn,
                    checks=run_checks(case, turn),
                    judge=score,
                    judge_preferred=preferred,
                    cost_usd=cost_usd(model, turn.input_tokens, turn.output_tokens),
                )
            )
    return results, (judge_tokens[0], judge_tokens[1])
