"""Token prices and the up-front cost estimate for an eval run.

Prices are Gemini API paid-tier standard rates per 1M tokens (prompts under
200k), checked against ai.google.dev/gemini-api/docs/pricing on 2026-10-02.
Output prices include thinking tokens.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.config import Settings

# model id -> (input $/1M, output $/1M)
PRICES: dict[str, tuple[float, float]] = {
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-pro-preview": (2.00, 12.00),
}

# Planning assumptions. Past chat turns on gemini-3.8-flash averaged ~9.7k
# input / ~600 output tokens (p90 ~16.5k input); eval questions skew toward
# multi-step research, so the estimate uses a heavier turn.
EST_TURN_TOKENS = (13_000, 900)
# One judge call grades every model's answer to a question, with evidence.
EST_JUDGE_TOKENS = (9_000, 1_500)


def model_id(spec: str) -> str:
    """ "google_genai:gemini-3.8-flash" -> "gemini-3.8-flash"."""
    return spec.split(":", 1)[-1]


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    price_in, price_out = PRICES.get(model_id(model), (0.0, 0.0))
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def has_price(model: str) -> bool:
    return model_id(model) in PRICES


@dataclass(frozen=True)
class Estimate:
    agent_usd: dict[str, float]
    judge_usd: float
    judge_model: str
    judged_questions: int

    @property
    def total_usd(self) -> float:
        return sum(self.agent_usd.values()) + self.judge_usd


def estimate(
    *,
    turns: int,
    judged_questions: int,
    models: list[str],
    judge_model: str,
    turn_tokens: tuple[int, int] = EST_TURN_TOKENS,
    judge_tokens: tuple[int, int] = EST_JUDGE_TOKENS,
) -> Estimate:
    """Expected spend: every case on every model, one judge call per question."""
    agent = {m: turns * cost_usd(m, *turn_tokens) for m in models}
    # Judge input grows with the number of answers it compares.
    judge_in = int(judge_tokens[0] * max(1, len(models)) / 2)
    judge = judged_questions * cost_usd(judge_model, judge_in, judge_tokens[1])
    return Estimate(agent, judge, judge_model, judged_questions)


# --- Research reports ------------------------------------------------------------
# Per report, by agent: (input, output) tokens. "Typical" comes from the
# 2026-10-08 eval run: the Flash transcript researcher used all 5 calls and 4
# searches (70K-73K in / 2.3K-3.4K out); with 2 searches it makes about 3
# calls of a growing ~12K-18K context, hence ~45K in. Market analyst ~5K /
# 0.4K; writer 10.8K-14.2K / 2.4K-2.6K. "Most" assumes every agent uses its
# full step limit and output cap, plus the comparison guards: the transcript
# researcher's corrective turn reruns its agent, and the writer may write
# twice.
EST_REPORT_TOKENS: dict[str, tuple[int, int]] = {
    "transcripts": (45_000, 3_500),
    "market": (6_000, 600),
    "writer": (15_000, 3_000),
}
# Largest context per model call, for the upper bound.
MAX_REPORT_CONTEXT = {"transcripts": 22_000, "market": 8_000, "writer": 16_000}
# Agent runs at most: the transcript researcher's corrective turn, the
# writer's retry.
MAX_REPORT_RUNS = {"transcripts": 2, "market": 1, "writer": 2}
# Rerank calls per report: two for the comparison plus one per search, in
# each of the transcript researcher's runs.
COMPARISON_RERANKS = 2


@dataclass(frozen=True)
class ReportEstimate:
    reports: int
    typical_usd: dict[str, float]
    most_usd: dict[str, float]
    models: dict[str, str]
    reranks_max: int

    @property
    def typical_total(self) -> float:
        return self.reports * sum(self.typical_usd.values())

    @property
    def most_total(self) -> float:
        return self.reports * sum(self.most_usd.values())


def estimate_reports(settings: "Settings", reports: int) -> ReportEstimate:
    """Expected and worst-case spend for ``reports`` research reports."""
    models = {
        "transcripts": settings.report_transcript_model,
        "market": settings.report_market_model,
        "writer": settings.report_writer_model,
    }
    calls_per_run = {
        "transcripts": settings.report_transcript_max_model_calls,
        "market": settings.report_market_max_model_calls,
        "writer": 1,
    }
    calls = {agent: n * MAX_REPORT_RUNS[agent] for agent, n in calls_per_run.items()}
    max_output = {
        "transcripts": settings.report_transcript_max_output_tokens,
        "market": settings.report_market_max_output_tokens,
        "writer": settings.report_writer_max_output_tokens,
    }
    typical = {
        agent: cost_usd(models[agent], *tokens)
        for agent, tokens in EST_REPORT_TOKENS.items()
    }
    most = {
        agent: cost_usd(
            models[agent],
            calls[agent] * MAX_REPORT_CONTEXT[agent],
            calls[agent] * max_output[agent],
        )
        for agent in models
    }
    return ReportEstimate(
        reports=reports,
        typical_usd=typical,
        most_usd=most,
        models={agent: model_id(spec) for agent, spec in models.items()},
        reranks_max=reports
        * (
            COMPARISON_RERANKS
            + MAX_REPORT_RUNS["transcripts"] * settings.report_transcript_max_tool_calls
        ),
    )
