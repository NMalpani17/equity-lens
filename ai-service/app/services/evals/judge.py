"""LLM-as-judge: blind, order-randomized rubric grading of every model's answer.

One judge call per question sees all models' answers to it, labeled only
"A", "B", … in a random (seeded) order, each with the evidence that answer
had: its cited passages and its tool results. The judge never sees model
names. It scores each answer 1-5 on faithfulness, relevance and
completeness, and names the better answer (or a tie).
"""

import json
import random
import string
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langchain_core.language_models import BaseChatModel
from pydantic import BaseModel, Field

from .models import EvalCase, JudgeScore, TurnRecord

JUDGE_SYSTEM_PROMPT = """\
You grade answers produced by an equity-research assistant. Each answer comes \
with the evidence it had: transcript passages it cited and the results of the \
tools it called. Grade every answer independently against its own evidence.

Score each answer from 1 (poor) to 5 (excellent):
- faithfulness: every factual claim and number is supported by that answer's \
evidence. Any unsupported figure, invented quote or misattributed claim caps \
this at 2. Saying that information is unavailable is faithful.
- relevance: it addresses the question that was asked, without padding.
- completeness: it covers the main points the evidence (and the reference \
notes, if given) supports for this question.

Rules:
- Labels are letters only and their order is random; it carries no meaning.
- Length and confident tone are not quality. Do not prefer the longer answer.
- A short clarifying question is appropriate when the question is genuinely \
ambiguous; a disclaimer that the answer is not financial advice is required \
for buy/sell questions and is not a flaw.
- Then name the better answer overall in "preferred", or "tie".
"""

_MAX_TOOL_OUTPUT_CHARS = 2500
_MAX_EVIDENCE_CHARS = 12000


class JudgedAnswer(BaseModel):
    label: str = Field(description="The answer's letter label.")
    faithfulness: int = Field(ge=1, le=5)
    relevance: int = Field(ge=1, le=5)
    completeness: int = Field(ge=1, le=5)
    rationale: str = Field(description="One or two sentences.")


class JudgeVerdict(BaseModel):
    answers: list[JudgedAnswer]
    preferred: str = Field(description='The better answer\'s label, or "tie".')


# (prompt) -> (verdict, (input_tokens, output_tokens))
JudgeCall = Callable[[str], Awaitable[tuple[JudgeVerdict, tuple[int, int]]]]


@dataclass(frozen=True)
class CaseJudgement:
    scores: dict[str, JudgeScore]  # model -> score
    preferred_model: str | None  # None for a tie or a single model
    labels: dict[str, str]  # label -> model (for the record)
    input_tokens: int
    output_tokens: int


def evidence_for(turn: TurnRecord) -> str:
    """The passages and tool results an answer could draw on."""
    parts = []
    for c in turn.citations:
        parts.append(
            f"[{c.get('id')}] {c.get('ticker')} Q{c.get('fiscal_quarter')} "
            f"FY{c.get('fiscal_year')}, {c.get('speaker')}: {c.get('text')}"
        )
    for call in turn.tool_calls:
        args = json.dumps(call.args, default=str)
        output = call.output[:_MAX_TOOL_OUTPUT_CHARS]
        parts.append(f"Tool {call.name}({args}) returned:\n{output}")
    text = "\n\n".join(parts) or "(no tool results or citations)"
    return text[:_MAX_EVIDENCE_CHARS]


def assign_labels(models: list[str], case_id: str, seed: int) -> dict[str, str]:
    """label -> model, shuffled reproducibly per case."""
    order = list(models)
    random.Random(f"{seed}:{case_id}").shuffle(order)
    return {string.ascii_uppercase[i]: model for i, model in enumerate(order)}


def build_prompt(
    case: EvalCase, labels: dict[str, str], turns: dict[str, TurnRecord]
) -> str:
    lines = [f"QUESTION:\n{case.question}"]
    if case.reference:
        lines.append(
            f"REFERENCE NOTES (what a complete answer covers):\n{case.reference}"
        )
    for label, model in labels.items():
        turn = turns[model]
        lines.append(
            f"### Answer {label}\n{turn.content or '(empty answer)'}\n\n"
            f"#### Evidence available to Answer {label}\n{evidence_for(turn)}"
        )
    return "\n\n".join(lines)


async def judge_case(
    call: JudgeCall,
    case: EvalCase,
    turns: dict[str, TurnRecord],
    *,
    seed: int = 7,
) -> CaseJudgement:
    """Grade every model's answer to one case in a single blind call."""
    labels = assign_labels(sorted(turns), case.id, seed)
    verdict, (tokens_in, tokens_out) = await call(build_prompt(case, labels, turns))
    scores = {
        labels[a.label.strip().upper()]: JudgeScore(
            faithfulness=a.faithfulness,
            relevance=a.relevance,
            completeness=a.completeness,
            rationale=a.rationale,
        )
        for a in verdict.answers
        if a.label.strip().upper() in labels
    }
    preferred = (
        labels.get(verdict.preferred.strip().upper()) if len(labels) > 1 else None
    )
    return CaseJudgement(scores, preferred, labels, tokens_in, tokens_out)


def llm_judge(model: BaseChatModel) -> JudgeCall:
    """A JudgeCall backed by a chat model with structured output."""
    structured = model.with_structured_output(JudgeVerdict, include_raw=True)

    async def call(prompt: str) -> tuple[JudgeVerdict, tuple[int, int]]:
        result: Any = await structured.ainvoke(
            [("system", JUDGE_SYSTEM_PROMPT), ("human", prompt)]
        )
        if result.get("parsing_error") or result.get("parsed") is None:
            raise ValueError(
                f"judge returned unparseable output: {result.get('parsing_error')}"
            )
        usage = getattr(result["raw"], "usage_metadata", None) or {}
        return result["parsed"], (
            int(usage.get("input_tokens", 0)),
            int(usage.get("output_tokens", 0)),
        )

    return call
