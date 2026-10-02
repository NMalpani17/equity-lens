"""Chat eval: labeled data, deterministic checks, blind judging, scoring, reports.

Models are mocked throughout: the agent is scripted and the judge is a fake.
"""

import asyncio
import json
from datetime import date
from typing import Any, get_args
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from app.config import Settings
from app.services.chat import mcp_server
from app.services.chat.agent import ChatService
from app.services.chat.context import TurnContext, turn_registry
from app.services.chat.guardrails import ADVICE_NOTE, OFF_TOPIC_REPLY
from app.services.chat.tools import ToolDeps, calculate_position_tool
from app.services.evals.checks import run_checks
from app.services.evals.judge import (
    JudgedAnswer,
    JudgeVerdict,
    assign_labels,
    build_prompt,
    judge_case,
    llm_judge,
)
from app.services.evals.models import (
    Category,
    EvalCase,
    Expectations,
    ToolCallRecord,
    TurnRecord,
)
from app.services.evals.pricing import cost_usd, estimate
from app.services.evals.report import category_table, markdown_table, summarize
from app.services.evals.runner import EvalTracer, demo_portfolio, run_case
from app.services.evals.scoring import score_cases
from app.services.observability.tracing import NoopTracer, TurnTrace
from scripts.eval_chat import (
    DEFAULT_CASES,
    FLASH_JUDGE,
    PRO_JUDGE,
    choose_judge,
    load_cases,
)
from tests.chat_fakes import ScriptedChatModel, ai

FLASH = "google_genai:gemini-3.8-flash"
LITE = "google_genai:gemini-3.5-flash-lite"


def case(**expect: Any) -> EvalCase:
    return EvalCase(
        id="c1",
        category="transcript_fact",
        question="What did NVDA say?",
        expect=Expectations(**expect),
    )


def turn(content: str = "Answer.", model: str = FLASH, **kwargs: Any) -> TurnRecord:
    defaults: dict[str, Any] = {"status": "complete", "case_id": "c1"}
    return TurnRecord(model=model, content=content, **{**defaults, **kwargs})


def citation(i: int, ticker: str = "NVDA", year: int = 2027, quarter: int = 2) -> dict:
    return {
        "id": i,
        "ticker": ticker,
        "fiscal_year": year,
        "fiscal_quarter": quarter,
        "speaker": "CFO",
        "text": f"passage {i}",
    }


def failed(results) -> list[str]:
    return [r.name for r in results if not r.passed]


# --- labeled data ---------------------------------------------------------------


def test_labeled_set_covers_every_category_with_unique_ids() -> None:
    cases = load_cases(DEFAULT_CASES)

    assert 20 <= len(cases) <= 30
    assert len({c.id for c in cases}) == len(cases)
    assert {c.category for c in cases} == set(get_args(Category))


def test_demo_portfolio_matches_the_labeled_numbers() -> None:
    snapshot = demo_portfolio()
    turn_ctx = TurnContext(
        user_id="u", is_anonymous=False, today=date(2026, 10, 2), portfolio=snapshot
    )

    assert snapshot.totals.market_value == 30495
    assert snapshot.totals.gain_loss == 8870
    buy = calculate_position_tool(
        turn_ctx, action="buy", shares=10, price=180, ticker="NVDA"
    ).data
    sell = calculate_position_tool(
        turn_ctx, action="sell", shares=10, price=230, ticker="AAPL"
    ).data
    assert buy["avg_cost_after"] == 112.4
    assert sell["realized_gain"] == 518


# --- deterministic checks ----------------------------------------------------------


def test_a_well_grounded_answer_passes_every_check() -> None:
    record = turn(
        "NVDA said demand was strong in Q2 FY2027 [1] and Q1 FY2027 [2].",
        citations=[citation(1), citation(2, quarter=1)],
        tool_calls=[ToolCallRecord(name="search_transcripts")],
    )
    spec = case(
        tools=["search_transcripts"],
        citations=True,
        citation_tickers=["NVDA"],
        min_citation_quarters=2,
        forbid_tools=["get_portfolio"],
    )

    assert failed(run_checks(spec, record)) == []


def test_citation_and_tool_failures_are_reported() -> None:
    record = turn(
        "AMD said something [1] and more [7].",
        citations=[citation(1, ticker="AMD")],
        tool_calls=[ToolCallRecord(name="get_portfolio")],
    )
    spec = case(
        tools=["search_transcripts"],
        forbid_tools=["get_portfolio"],
        citations=True,
        citation_tickers=["NVDA"],
        min_citation_quarters=2,
    )

    results = {r.name: r for r in run_checks(spec, record)}

    assert failed(results.values()) == [
        "citations_valid",
        "expected_tools",
        "forbidden_tools",
        "citation_tickers",
        "citation_quarters",
    ]
    assert results["citations_valid"].detail == "unresolved markers [7]"
    assert results["citation_tickers"].detail == "cited ['AMD']"


@pytest.mark.parametrize(
    ("record", "refused"),
    [
        (turn(OFF_TOPIC_REPLY, status="refused"), True),
        (turn("Sorry, I can only help with stocks and investing."), True),
        (turn("I can only assist with stocks, earnings calls and markets."), True),
        (turn("Day 1: Tokyo. Day 2: Kyoto."), False),
    ],
)
def test_refusal_detection(record, refused) -> None:
    results = run_checks(case(refusal=True, no_tools=True), record)
    assert ("refusal" not in failed(results)) is refused


def test_clarify_requires_a_question_and_no_transcript_search() -> None:
    asks = turn("Do you mean Delta Air Lines (DAL) or Delta Apparel (DLA)?")
    guessed = turn(
        "Do you mean DAL? Anyway, fuel costs fell.",
        tool_calls=[ToolCallRecord(name="search_transcripts")],
    )

    assert failed(run_checks(case(clarify=True), asks)) == []
    assert "clarifies" in failed(run_checks(case(clarify=True), guessed))


def test_numbers_charts_notes_and_mentions() -> None:
    record = turn(
        f"Your new average cost would be $112.40 on 50 shares. {ADVICE_NOTE}",
        charts=[{"kind": "price_history"}],
    )

    ok = case(
        numbers=[112.4, 50],
        charts=["price_history"],
        advice_note=True,
        mentions=["average cost"],
        not_mentions=["you should buy"],
    )
    bad = case(numbers=[112.5], charts=["portfolio_allocation"], mentions=["SBUX"])

    assert failed(run_checks(ok, record)) == []
    assert failed(run_checks(bad, record)) == ["charts", "numbers", "mentions"]


def test_the_advice_note_may_be_worded_by_the_model() -> None:
    own = turn("Facts... This is general information, not financial advice.")
    none = turn("Facts and a recommendation to buy.")

    assert failed(run_checks(case(advice_note=True), own)) == []
    assert failed(run_checks(case(advice_note=True), none)) == ["advice_note"]


def test_a_failed_turn_fails_with_its_error() -> None:
    results = run_checks(
        case(tools=["search_transcripts"]), turn(error="ai_timeout: x")
    )
    assert [(r.name, r.passed, r.detail) for r in results] == [
        ("completed", False, "ai_timeout: x")
    ]


# --- blind judge ---------------------------------------------------------------------


def test_labels_are_reproducible_and_order_varies_across_cases() -> None:
    models = [FLASH, LITE]

    assert assign_labels(models, "t01", 7) == assign_labels(models, "t01", 7)
    firsts = {assign_labels(models, f"case{i}", 7)["A"] for i in range(20)}
    assert firsts == {FLASH, LITE}


def test_the_judge_prompt_hides_model_names() -> None:
    turns = {
        FLASH: turn("First answer [1].", citations=[citation(1)]),
        LITE: turn("Second answer.", model=LITE),
    }
    labels = assign_labels(sorted(turns), "c1", 7)

    prompt = build_prompt(case(), labels, turns)

    assert "gemini" not in prompt.lower() and "flash" not in prompt.lower()
    assert "### Answer A" in prompt and "### Answer B" in prompt
    assert "passage 1" in prompt  # each answer's evidence is included


def fake_judge(preferred: str = "A", scores: dict[str, int] | None = None):
    prompts: list[str] = []
    scores = scores or {"A": 5, "B": 3}

    async def call(prompt: str):
        prompts.append(prompt)
        verdict = JudgeVerdict(
            answers=[
                JudgedAnswer(
                    label=label,
                    faithfulness=score,
                    relevance=score,
                    completeness=score,
                    rationale=f"{label} rationale",
                )
                for label, score in scores.items()
            ],
            preferred=preferred,
        )
        return verdict, (1000, 200)

    return call, prompts


def test_judge_scores_are_mapped_back_to_the_right_model() -> None:
    turns = {FLASH: turn("x"), LITE: turn("y", model=LITE)}
    call, _ = fake_judge(preferred="a")

    judgement = asyncio.run(judge_case(call, case(), turns, seed=7))

    labels = assign_labels(sorted(turns), "c1", 7)
    assert judgement.labels == labels
    assert judgement.preferred_model == labels["A"]
    assert judgement.scores[labels["A"]].faithfulness == 5
    assert judgement.scores[labels["B"]].faithfulness == 3
    assert (judgement.input_tokens, judgement.output_tokens) == (1000, 200)


def test_a_tie_prefers_no_model() -> None:
    call, _ = fake_judge(preferred="tie")
    turns = {FLASH: turn("x"), LITE: turn("y", model=LITE)}

    assert asyncio.run(judge_case(call, case(), turns)).preferred_model is None


class StubStructured:
    def __init__(self, result: dict) -> None:
        self.result = result
        self.messages: list = []

    async def ainvoke(self, messages):
        self.messages = messages
        return self.result


def test_llm_judge_uses_structured_output_and_reports_usage() -> None:
    verdict = JudgeVerdict(answers=[], preferred="tie")
    raw = AIMessage(
        "",
        usage_metadata={
            "input_tokens": 900,
            "output_tokens": 120,
            "total_tokens": 1020,
        },
    )
    stub = StubStructured({"parsed": verdict, "raw": raw, "parsing_error": None})
    model = MagicMock()
    model.with_structured_output.return_value = stub

    parsed, usage = asyncio.run(llm_judge(model)("prompt"))

    model.with_structured_output.assert_called_once_with(JudgeVerdict, include_raw=True)
    assert parsed is verdict and usage == (900, 120)
    assert stub.messages[0][0] == "system" and stub.messages[1] == ("human", "prompt")


def test_llm_judge_rejects_unparseable_output() -> None:
    stub = StubStructured(
        {"parsed": None, "raw": AIMessage(""), "parsing_error": "bad"}
    )
    model = MagicMock()
    model.with_structured_output.return_value = stub

    with pytest.raises(ValueError, match="unparseable"):
        asyncio.run(llm_judge(model)("prompt"))


# --- scoring and reports ------------------------------------------------------------


def test_score_cases_combines_checks_judge_and_cost() -> None:
    judged = EvalCase(
        id="j1", category="portfolio", question="q", expect=Expectations()
    )
    refusal = EvalCase(
        id="r1",
        category="off_topic",
        question="poem",
        expect=Expectations(refusal=True),
        judge=False,
    )
    turns = {
        FLASH: {
            "j1": turn("ok", case_id="j1", input_tokens=10_000, output_tokens=1_000),
            "r1": turn(OFF_TOPIC_REPLY, case_id="r1", status="refused"),
        },
        LITE: {
            "j1": turn("ok", model=LITE, case_id="j1"),
            "r1": turn("Here is a poem.", model=LITE, case_id="r1"),
        },
    }
    call, prompts = fake_judge()

    results, judge_tokens = asyncio.run(score_cases([judged, refusal], turns, call))

    assert len(prompts) == 1 and judge_tokens == (1000, 200)  # refusals not judged
    by_key = {(r.turn.model, r.case.id): r for r in results}
    assert by_key[(FLASH, "r1")].passed and not by_key[(LITE, "r1")].passed
    assert by_key[(FLASH, "r1")].judge is None
    assert by_key[(FLASH, "j1")].cost_usd == pytest.approx(
        cost_usd(FLASH, 10_000, 1_000)
    )
    assert {
        by_key[(FLASH, "j1")].judge_preferred,
        by_key[(LITE, "j1")].judge_preferred,
    } == {
        True,
        False,
    }


def test_a_judge_failure_leaves_the_case_unjudged() -> None:
    async def broken(_prompt: str):
        raise RuntimeError("judge down")

    results, tokens = asyncio.run(
        score_cases([case()], {FLASH: {"c1": turn()}}, broken)
    )

    assert results[0].judge is None and results[0].passed and tokens == (0, 0)


def test_summary_table_reports_quality_latency_and_cost() -> None:
    turns = {
        FLASH: {"c1": turn("x", latency_s=4.0, input_tokens=12_000, output_tokens=800)},
        LITE: {"c1": turn("y", model=LITE, latency_s=2.0, input_tokens=12_000)},
    }
    call, _ = fake_judge(scores={"A": 4, "B": 2})
    results, _ = asyncio.run(score_cases([case()], turns, call))

    summaries = {s.model: s for s in summarize(results)}
    table = markdown_table(list(summaries.values()))

    assert summaries[FLASH].passed == 1 and summaries[FLASH].latency_p50 == 4.0
    assert summaries[FLASH].cost_per_turn == pytest.approx(cost_usd(FLASH, 12_000, 800))
    assert sum(s.judge_wins for s in summaries.values()) == 1
    assert "`gemini-3.8-flash`" in table and "`gemini-3.5-flash-lite`" in table
    assert "| transcript fact | 1/1 | 1/1 |" in category_table(list(summaries.values()))


def test_estimate_picks_pro_only_within_budget() -> None:
    cases = load_cases(DEFAULT_CASES)
    pro = estimate(
        turns=len(cases),
        judged_questions=sum(c.judge for c in cases),
        models=[FLASH, LITE],
        judge_model=PRO_JUDGE,
    )

    assert pro.judge_usd > 0 and pro.agent_usd[FLASH] > pro.agent_usd[LITE]
    assert choose_judge(cases, [FLASH, LITE], budget=pro.total_usd + 0.01) == PRO_JUDGE
    assert (
        choose_judge(cases, [FLASH, LITE], budget=pro.total_usd - 0.01) == FLASH_JUDGE
    )


# --- running a case through the agent ----------------------------------------------


class InnerTracer(NoopTracer):
    def start_turn(self, **_: Any) -> TurnTrace:
        return TurnTrace(
            config={"callbacks": ["inner"]}, handler=MagicMock(last_trace_id="t1")
        )


def test_eval_tracer_keeps_the_real_callbacks_and_adds_a_collector() -> None:
    tracer = EvalTracer(InnerTracer())

    trace = tracer.start_turn(user_id="u", session_id=None)

    assert trace.config["callbacks"] == ["inner", tracer.collector]
    assert trace.trace_id == "t1"


def test_run_case_records_tools_usage_and_the_answer() -> None:
    deps = ToolDeps(
        search=MagicMock, market=MagicMock, history=MagicMock, resolver=MagicMock
    )
    mcp_server.set_tool_deps(lambda: deps)
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}], usage=(500, 30)),
            ai("Your portfolio is worth $30,495.", usage=(900, 40)),
        ]
    )
    tracer = EvalTracer()
    service = ChatService(
        Settings(_env_file=None, internal_token="t", gemini_api_key="k"),
        lambda: model,
        mcp_server.mcp,
        turn_registry,
        tracer=tracer,
    )
    spec = EvalCase(id="p01", category="portfolio", question="How is my portfolio?")

    try:
        record = asyncio.run(
            run_case(service, tracer, spec, model=FLASH, portfolio=demo_portfolio())
        )
    finally:
        mcp_server.set_tool_deps(mcp_server.default_tool_deps)

    assert record.content == "Your portfolio is worth $30,495."
    assert record.status == "complete" and record.error is None
    assert (record.input_tokens, record.output_tokens) == (1400, 70)
    assert record.tool_names == ["get_portfolio"]
    assert json.loads(record.tool_calls[0].output)["totals"]["market_value"] == 30495
    assert record.charts[0]["kind"] == "portfolio_allocation"
    assert record.latency_s >= 0


def test_a_guardrail_refusal_records_no_tools_from_the_previous_case() -> None:
    deps = ToolDeps(
        search=MagicMock, market=MagicMock, history=MagicMock, resolver=MagicMock
    )
    mcp_server.set_tool_deps(lambda: deps)
    model = ScriptedChatModel(
        script=[ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}]), ai("Done.")]
    )
    tracer = EvalTracer()
    service = ChatService(
        Settings(_env_file=None, internal_token="t", gemini_api_key="k"),
        lambda: model,
        mcp_server.mcp,
        turn_registry,
        tracer=tracer,
    )
    first = EvalCase(id="p01", category="portfolio", question="How is my portfolio?")
    refused = EvalCase(id="o01", category="off_topic", question="Write me a poem.")

    async def both():
        portfolio = demo_portfolio()
        await run_case(service, tracer, first, model=FLASH, portfolio=portfolio)
        return await run_case(
            service, tracer, refused, model=FLASH, portfolio=portfolio
        )

    try:
        record = asyncio.run(both())
    finally:
        mcp_server.set_tool_deps(mcp_server.default_tool_deps)

    assert record.status == "refused" and record.tool_calls == []
