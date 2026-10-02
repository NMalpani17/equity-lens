"""Token prices and the up-front cost estimate for an eval run.

Prices are Gemini API paid-tier standard rates per 1M tokens (prompts under
200k), checked against ai.google.dev/gemini-api/docs/pricing on 2026-10-02.
Output prices include thinking tokens.
"""

from dataclasses import dataclass

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
