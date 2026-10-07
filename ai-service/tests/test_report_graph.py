"""The report graph: parallel researchers, the writer, validation and failures.

Real MCP tools (with fake data services), real create_agent loops, and
scripted models; no network.
"""

import asyncio
import warnings
from datetime import UTC, date, datetime
from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda

from app.config import Settings
from app.models.quote import Quote
from app.models.rag import RagFilters, RagSearchResponse
from app.models.report import ReportDraft
from app.services.chat import mcp_server, tools
from app.services.chat.agent import TurnClient
from app.services.chat.citations import CitationNumbering, CitationRegistry
from app.services.chat.context import TurnContext, turn_registry
from app.services.chat.tools import ToolDeps
from app.services.market_data.base import ProviderUnavailableError
from app.services.report.assemble import PRICE_UNAVAILABLE, assemble_report
from app.services.report.graph import (
    ReportAgents,
    ReportError,
    ReportInputs,
    build_report_graph,
    run_report_graph,
)
from app.services.report.sources import DataSourceRegistry, validate_data_refs
from tests.chat_fakes import ai, search_result
from tests.test_chat_charts import history, history_result
from tests.test_chat_comparison import comparison

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from langchain.mcp import MCPAdapter

TODAY = date(2026, 10, 7)


class ByPromptModel(BaseChatModel):
    """Scripted replies per agent, chosen by the agent's system prompt.

    The researchers run concurrently, so one shared script would interleave.
    """

    scripts: dict[str, list[AIMessage]]
    calls: dict[str, int] = {}
    seen: dict[str, list[list[BaseMessage]]] = {}

    @property
    def _llm_type(self) -> str:
        return "by-prompt"

    def bind_tools(self, tools: Any, **_: Any) -> "ByPromptModel":
        return self

    def _key(self, messages: list[BaseMessage]) -> str:
        system = next((m.text for m in messages if isinstance(m, SystemMessage)), "")
        return next(k for k in self.scripts if k in system)

    def _generate(self, messages, stop=None, run_manager=None, **_: Any) -> ChatResult:
        key = self._key(messages)
        self.seen.setdefault(key, []).append(list(messages))
        n = self.calls.get(key, 0)
        script = self.scripts[key]
        reply = script[min(n, len(script) - 1)]
        self.calls[key] = n + 1
        return ChatResult(generations=[ChatGeneration(message=reply)])


TRANSCRIPT_KEY = "transcript researcher"
MARKET_KEY = "market-data analyst"

TRANSCRIPT_NOTES = """## Drivers
- Data center demand drove Q2 FY2027 revenue [1][5].
## Guidance
- Management guided higher for Q3 [2].
## Changes
### Raised / improved
- Guidance rose from Q1 FY2027 [3] to Q2 FY2027 [2].
## Risks
- Supply constraints persist [1]."""

MARKET_NOTES = "- NVDA last traded at 181.5 [quote]; up 20% over 6 months."


def research_script(**overrides: list[AIMessage]) -> dict[str, list[AIMessage]]:
    scripts = {
        TRANSCRIPT_KEY: [
            ai(
                tool_calls=[
                    {
                        "name": "search_transcripts",
                        "args": {"query": "demand drivers", "ticker": "NVDA"},
                        "id": "t1",
                    }
                ],
                usage=(1000, 50),
            ),
            ai(TRANSCRIPT_NOTES, usage=(3000, 400)),
        ],
        MARKET_KEY: [
            ai(
                tool_calls=[
                    {"name": "get_quote", "args": {"ticker": "NVDA"}, "id": "m1"},
                    {
                        "name": "get_price_history",
                        "args": {"ticker": "NVDA", "period": "6mo"},
                        "id": "m2",
                    },
                ],
                usage=(500, 30),
            ),
            ai(MARKET_NOTES, usage=(900, 80)),
        ],
    }
    return {**scripts, **overrides}


DRAFT = ReportDraft(
    summary="Data center demand led Q2 FY2027 [1], and the stock rose [D2].",
    drivers="- Data center demand [1][5]. Unverified claim [42].",
    guidance="- Guidance rose [2]; a passage the notes never cited [4].",
    changes=(
        "### Raised / improved\n"
        "- Guidance rose from Q1 FY2027 [3] to Q2 FY2027 [2].\n\n"
        "New, Lowered / worse, No longer mentioned, Unchanged: nothing found in "
        "the retrieved passages."
    ),
    stock="- Last price 181.5 as of the quote time [D1]; 6-month change 20% [D2][D9].",
    risks="- Supply constraints [1].",
)


def writer(draft: ReportDraft | None = DRAFT, seen: list | None = None):
    def respond(messages: list[BaseMessage]) -> dict:
        if seen is not None:
            seen.append(messages)
        raw = ai("{...}", usage=(6000, 1500))
        return {"raw": raw, "parsed": draft, "parsing_error": None}

    return RunnableLambda(respond)


@pytest.fixture
def deps():
    search = MagicMock()
    search.search.return_value = RagSearchResponse(
        query="q",
        filters=RagFilters(ticker="NVDA"),
        reranked=True,
        candidate_count=10,
        results=[search_result(0), search_result(1)],
        latency_ms=5,
    )
    market = MagicMock()
    market.get_quote.return_value = Quote(
        ticker="NVDA",
        price=181.5,
        previous_close=178.0,
        change=3.5,
        change_percent=1.97,
        provider="finnhub",
        as_of=datetime(2026, 10, 6, 20, 0, tzinfo=UTC),
    )
    history_service = MagicMock()
    history_service.get_history.return_value = history()
    compare_service = MagicMock()
    compare_service.compare.return_value = comparison()
    tool_deps = ToolDeps(
        search=lambda: search,
        market=lambda: market,
        history=lambda: history_service,
        resolver=MagicMock,
        comparison=lambda: compare_service,
    )
    mcp_server.set_tool_deps(lambda: tool_deps)
    yield tool_deps
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


def settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, gemini_api_key="k", internal_token="t", **overrides)


def make_agents(tool_deps: ToolDeps, model: ByPromptModel, writer_runnable, **cfg):
    return ReportAgents(
        settings=settings(**cfg),
        research_model=lambda: model,
        writer=lambda: writer_runnable,
        compare=lambda turn, ticker: tools.compare_quarters(
            tool_deps, turn, ticker=ticker
        ),
    )


def report_turn() -> TurnContext:
    return TurnContext(
        user_id="report",
        is_anonymous=False,
        today=TODAY,
        portfolio=None,
        time_zone="America/New_York",
    )


def run(agents: ReportAgents) -> tuple[list[dict], dict, TurnContext]:
    turn = report_turn()

    async def go() -> tuple[list[dict], dict]:
        turn_registry.register(turn)
        try:
            async with MCPAdapter(
                TurnClient(mcp_server.mcp, turn_id=turn.turn_id)
            ) as a:
                graph = build_report_graph(
                    agents,
                    ReportInputs("NVDA", "Nvidia Corp", TODAY),
                    turn,
                    await a.list_tools(),
                )
                events, final = [], {}
                async for kind, item in run_report_graph(graph, {}):
                    if kind == "progress":
                        events.append(item)
                    else:
                        final = item
                return events, final
        finally:
            turn_registry.discard(turn.turn_id)

    events, final = asyncio.run(go())
    return events, final, turn


def assemble(final: dict, turn: TurnContext, **cfg: Any):
    return assemble_report(
        final,
        ticker="NVDA",
        company_name="Nvidia Corp",
        registry=turn.sources,
        settings=settings(**cfg),
    )


def test_researchers_run_in_parallel_then_the_writer(deps) -> None:
    model = ByPromptModel(scripts=research_script())
    events, final, turn = run(make_agents(deps, model, writer()))

    order = [(e["agent"], e["state"]) for e in events]
    assert set(order[:2]) == {("transcripts", "running"), ("market", "running")}
    assert order.index(("writer", "running")) > max(
        order.index(("transcripts", "done")), order.index(("market", "done"))
    )
    assert order[-1] == ("writer", "done")
    labels = {e["agent"]: e["label"] for e in events}
    assert labels == {
        "transcripts": "Researching transcripts…",
        "market": "Analyzing price data…",
        "writer": "Writing report…",
    }
    # Each researcher had its own prompt and only its own tools.
    assert model.calls == {TRANSCRIPT_KEY: 2, MARKET_KEY: 2}
    runs = {r.agent: r for r in final["runs"]}
    assert runs["transcripts"].tool_calls == 1 and runs["market"].tool_calls == 2
    assert runs["writer"].model == "gemini-3.8-flash"
    assert runs["transcripts"].model == "gemini-3.5-flash-lite"
    assert runs["writer"].input_tokens == 6000 and runs["writer"].cost_usd > 0
    assert all(r.status == "ok" and r.latency_ms >= 0 for r in runs.values())


def test_report_cites_only_passages_the_writer_saw_and_known_data(deps) -> None:
    seen: list = []
    model = ByPromptModel(scripts=research_script())
    _, final, turn = run(make_agents(deps, model, writer(seen=seen)))

    report = assemble(final, turn)

    assert [s.key for s in report.sections] == [
        "summary",
        "drivers",
        "guidance",
        "changes",
        "stock",
        "risks",
    ]
    text = {s.key: s.markdown for s in report.sections}
    # One numbering across sections: [1] then [5]->[2], [2]->[3], [3]->[4].
    assert text["summary"].startswith("Data center demand led Q2 FY2027 [1]")
    assert text["drivers"] == "- Data center demand [1][2]. Unverified claim."
    # [4] is a real passage, but the notes never cited it, so the writer never saw it.
    assert text["guidance"] == "- Guidance rose [3]; a passage the notes never cited."
    assert "Q1 FY2027 [4] to Q2 FY2027 [3]" in text["changes"]
    assert text["stock"].endswith("6-month change 20% [D2].")  # [D9] dropped
    assert [c.id for c in report.citations] == [1, 2, 3, 4]
    assert {(c.fiscal_quarter) for c in report.citations} == {1, 2}

    task = seen[0][1].text
    assert '<passage id="4"' not in task and '<passage id="3"' in task
    assert [s.id for s in report.data_sources] == ["D1", "D2"]
    assert report.chart is not None and report.chart.period == "6mo"
    assert report.as_of.quote and report.as_of.prices == "2026-04-04"
    assert (
        report.quarter.fiscal_quarter == 2 and report.prior_quarter.fiscal_quarter == 1
    )
    assert report.as_of.latest_call == "2026-08-26"
    assert report.market_data_available is True
    assert "not financial advice" in report.disclaimer
    # Shared content: nothing about the requesting user is stored.
    assert "user" not in report.model_dump_json().lower()


def test_report_ships_without_price_data_when_the_market_analyst_fails(deps) -> None:
    deps.market().get_quote.side_effect = ProviderUnavailableError("down")
    deps.history().get_history.side_effect = ProviderUnavailableError("down")
    seen: list = []
    model = ByPromptModel(scripts=research_script())
    events, final, turn = run(make_agents(deps, model, writer(seen=seen)))

    market = [e for e in events if e["agent"] == "market"]
    assert market[-1]["state"] == "failed"
    assert market[-1]["summary"] == "Price data unavailable"
    report = assemble(final, turn)
    assert report.section("stock").markdown == PRICE_UNAVAILABLE
    assert report.data_sources == [] and report.chart is None
    assert report.market_data_available is False
    assert "Price data was unavailable" in seen[0][0].text  # writer was told


def test_notes_without_citable_passages_fail_the_report(deps) -> None:
    scripts = research_script(**{TRANSCRIPT_KEY: [ai("## Drivers\n- Demand [99].")]})
    model = ByPromptModel(scripts=scripts)

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writer()))

    assert error.value.code == "research_failed"


def test_an_uncomparable_ticker_fails_with_a_clear_message(deps) -> None:
    deps.comparison().compare.return_value = comparison(
        status="not_enough_quarters",
        current=None,
        prior=None,
        themes=[],
        message="Only one call is indexed.",
    )
    model = ByPromptModel(scripts=research_script())

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writer()))

    assert error.value.code == "not_comparable"
    assert "Only one call" in error.value.message


def test_the_transcript_researcher_stops_at_its_step_limit(deps) -> None:
    loop = ai(
        tool_calls=[
            {"name": "search_transcripts", "args": {"query": "x", "ticker": "NVDA"}}
        ]
    )
    model = ByPromptModel(scripts=research_script(**{TRANSCRIPT_KEY: [loop]}))

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writer(), report_transcript_max_model_calls=3))

    assert error.value.code == "research_failed"
    assert model.calls[TRANSCRIPT_KEY] == 3


def test_a_writer_without_structured_output_fails(deps) -> None:
    model = ByPromptModel(scripts=research_script())

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writer(draft=None)))

    assert error.value.code == "writer_failed"


def test_an_empty_section_is_rejected(deps) -> None:
    model = ByPromptModel(scripts=research_script())
    empty = DRAFT.model_copy(update={"risks": "  [42] "})
    _, final, turn = run(make_agents(deps, model, writer(draft=empty)))

    with pytest.raises(ReportError, match="Risks"):
        assemble(final, turn)


def test_data_sources_are_numbered_once_per_tool_and_period() -> None:
    registry = DataSourceRegistry()
    first = registry.add("get_price_history", history_result(period="6mo"))
    again = registry.add("get_price_history", history_result(period="6mo"))
    year = registry.add("get_price_history", history_result(period="1y"))

    assert (first.id, again.id, year.id) == ("D1", "D1", "D2")
    assert registry.add("get_quote", {"status": "error"}) is None
    assert registry.add("get_portfolio", {"status": "ok"}) is None
    assert first.data["change_percent"] == 20.0 and "points" not in first.data


def test_data_refs_keep_known_ids_and_drop_others() -> None:
    refs = validate_data_refs("Up 20% [D2][D7] and 181.5 [D1] .", {"D1", "D2"})

    assert refs.text == "Up 20% [D2] and 181.5 [D1]."
    assert refs.cited == ["D2", "D1"] and refs.dropped == ["D7"]


def test_citation_numbering_spans_texts_and_honors_the_allow_list() -> None:
    registry = CitationRegistry()
    for i in range(3):
        registry.add(search_result(i))
    numbering = CitationNumbering(registry, allowed={2, 3})

    assert numbering.apply("A [3].") == "A [1]."
    assert numbering.apply("B [2][3][1].") == "B [1][2]."
    assert [c.id for c in numbering.citations] == [1, 2]
    assert numbering.dropped == [1]
