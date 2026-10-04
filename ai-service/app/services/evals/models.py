"""Data shapes for the chat evaluation: labeled cases, recorded turns, scores."""

from typing import Any, Literal

from pydantic import BaseModel, Field

Category = Literal[
    "transcript_fact",
    "multi_quarter",
    "quarter_comparison",
    "portfolio",
    "position_math",
    "advice",
    "off_topic",
    "prompt_injection",
    "ambiguous",
]


class Expectations(BaseModel):
    """Deterministic expectations for one case (all optional)."""

    # Every listed tool must be called / at least one of these / none of these.
    tools: list[str] = Field(default_factory=list)
    any_tools: list[str] = Field(default_factory=list)
    forbid_tools: list[str] = Field(default_factory=list)
    no_tools: bool = False
    # True: the answer must cite passages (from these tickers / quarters).
    citations: bool = False
    min_citations: int = 1
    citation_tickers: list[str] = Field(default_factory=list)
    min_citation_quarters: int = 0
    # 0 = no limit; with min_citation_quarters, pins the number of quarters.
    max_citation_quarters: int = 0
    # Exactly these quarters must be cited, e.g. ["FY2026Q2", "FY2026Q1"].
    citation_periods: list[str] = Field(default_factory=list)
    # Quarter-comparison answer structure (see comparison_sections()).
    comparison_sections: bool = False
    # Refuse or redirect (guardrail reply or a model redirect).
    refusal: bool = False
    # Ask a clarifying question instead of answering.
    clarify: bool = False
    advice_note: bool = False
    # Chart kinds that must be attached to the answer.
    charts: list[str] = Field(default_factory=list)
    # Numbers that must appear in the answer (within number_tolerance).
    numbers: list[float] = Field(default_factory=list)
    number_tolerance: float = 0.01
    # Case-insensitive substrings that must / must not appear.
    mentions: list[str] = Field(default_factory=list)
    not_mentions: list[str] = Field(default_factory=list)


class EvalCase(BaseModel):
    id: str
    category: Category
    question: str
    expect: Expectations = Field(default_factory=Expectations)
    # What a complete answer covers (shown to the judge; optional).
    reference: str | None = None
    # Refusals and clarifications are scored deterministically only.
    judge: bool = True


class ToolCallRecord(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    output: str = ""


class TurnRecord(BaseModel):
    """What one model produced for one case."""

    case_id: str
    model: str
    content: str = ""
    status: str = "error"
    citations: list[dict[str, Any]] = Field(default_factory=list)
    charts: list[dict[str, Any]] = Field(default_factory=list)
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    latency_s: float = 0.0
    error: str | None = None
    trace_id: str | None = None

    @property
    def tool_names(self) -> list[str]:
        return [t.name for t in self.tool_calls]


class CheckResult(BaseModel):
    name: str
    passed: bool
    detail: str = ""


class JudgeScore(BaseModel):
    faithfulness: int = Field(ge=1, le=5)
    relevance: int = Field(ge=1, le=5)
    completeness: int = Field(ge=1, le=5)
    rationale: str = ""

    @property
    def mean(self) -> float:
        return (self.faithfulness + self.relevance + self.completeness) / 3


class CaseResult(BaseModel):
    """One model's turn on one case, with every score."""

    case: EvalCase
    turn: TurnRecord
    checks: list[CheckResult] = Field(default_factory=list)
    judge: JudgeScore | None = None
    # True when the judge preferred this answer over the other model's.
    judge_preferred: bool | None = None
    cost_usd: float = 0.0

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)
