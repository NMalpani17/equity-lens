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
from app.models.comparison import ThemePassages
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
    COMPARISON_FAILED,
    Period,
    ReportAgents,
    ReportError,
    ReportInputs,
    build_report_graph,
    run_report_graph,
    with_prior_passages,
)
from app.services.report.prompts import NO_COMPARISON
from app.services.report.sources import DataSourceRegistry, validate_data_refs
from tests.chat_fakes import ai, search_result
from tests.test_chat_charts import history, history_result
from tests.test_chat_comparison import comparison
from tests.test_chat_comparison import passage as comparison_passage

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


def install_tool_deps() -> ToolDeps:
    """Fake data services behind the real MCP tools (search, market, compare)."""
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
    return tool_deps


@pytest.fixture
def deps():
    yield install_tool_deps()
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


def settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, gemini_api_key="k", internal_token="t", **overrides)


def make_agents(tool_deps: ToolDeps, model: ByPromptModel, writer_runnable, **cfg):
    return ReportAgents(
        settings=settings(**cfg),
        transcript_model=lambda: model,
        market_model=lambda: model,
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


LATEST = Period(2027, 2)


def run(
    agents: ReportAgents, latest: Period | None = LATEST
) -> tuple[list[dict], dict, TurnContext]:
    turn = report_turn()

    async def go() -> tuple[list[dict], dict]:
        turn_registry.register(turn)
        try:
            async with MCPAdapter(
                TurnClient(mcp_server.mcp, turn_id=turn.turn_id)
            ) as a:
                graph = build_report_graph(
                    agents,
                    ReportInputs("NVDA", "Nvidia Corp", TODAY, latest_quarter=latest),
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


USER_KEYS = {"user_id", "holdings", "portfolio", "email"}


def all_keys(value: Any) -> set[str]:
    """Every dict key at any depth."""
    if isinstance(value, dict):
        return set(value).union(*(all_keys(v) for v in value.values()))
    if isinstance(value, list):
        return set().union(*(all_keys(v) for v in value))
    return set()


def test_all_keys_finds_nested_keys() -> None:
    assert all_keys({"a": [{"user_id": 1}], "b": {"c": {"email": 2}}}) == {
        "a",
        "b",
        "c",
        "user_id",
        "email",
    }


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
    labels = {(e["agent"], e["state"]): e["label"] for e in events}
    assert labels == {
        ("transcripts", "running"): "Researching transcripts…",
        ("market", "running"): "Analyzing price data…",
        ("writer", "running"): "Writing report…",
        # Finished steps read in the past tense.
        ("transcripts", "done"): "Researched transcripts",
        ("market", "done"): "Analyzed price data",
        ("writer", "done"): "Wrote report",
    }
    # Each researcher had its own prompt and only its own tools.
    assert model.calls == {TRANSCRIPT_KEY: 2, MARKET_KEY: 2}
    runs = {r.agent: r for r in final["runs"]}
    assert runs["transcripts"].tool_calls == 1 and runs["market"].tool_calls == 2
    assert runs["writer"].model == "gemini-3.8-flash"
    # The transcript researcher runs on Flash, the market analyst on Flash-Lite.
    assert runs["transcripts"].model == "gemini-3.8-flash"
    assert runs["market"].model == "gemini-3.5-flash-lite"
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
    # Shared content: no user-specific field anywhere in what is stored.
    assert USER_KEYS.isdisjoint(all_keys(report.model_dump(mode="json")))


def test_dates_read_like_apr_8_2026(deps) -> None:
    seen: list = []
    draft = DRAFT.model_copy(
        update={
            "stock": "- Up 20% from 2025-10-06 to 2026-04-04 [D2]; not a date: "
            "2026-13-40."
        }
    )
    model = ByPromptModel(scripts=research_script())
    _, final, turn = run(make_agents(deps, model, writer(draft, seen=seen)))

    report = assemble(final, turn)

    stock = next(s.markdown for s in report.sections if s.key == "stock")
    assert stock == (
        "- Up 20% from Oct 6, 2025 to Apr 4, 2026 [D2]; not a date: 2026-13-40."
    )
    system = seen[0][0].text
    assert 'e.g. "Apr 8, 2026", never as "2026-04-08"' in system
    assert "earnings call (Aug 26, 2026)" in system
    # Stored dates stay ISO; the client formats them.
    assert report.as_of.latest_call == "2026-08-26"


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


def uncomparable() -> Any:
    return comparison(
        status="not_enough_quarters",
        current=None,
        prior=None,
        themes=[],
        message="Only one call is indexed.",
    )


def test_an_uncomparable_ticker_ships_without_the_comparison(deps) -> None:
    deps.comparison().compare.return_value = uncomparable()
    notes = (
        "## Drivers\n- Demand [1].\n## Guidance\n- Guided up [2].\n"
        "## Risks\n- Supply [1]."
    )
    scripts = research_script(
        **{TRANSCRIPT_KEY: [research_script()[TRANSCRIPT_KEY][0], ai(notes)]}
    )
    model = ByPromptModel(scripts=scripts)
    seen: list = []
    events, final, turn = run(make_agents(deps, model, writer(seen=seen)))

    report = assemble(final, turn)

    assert report.section("changes").markdown == NO_COMPARISON
    assert report.comparison_available is False
    assert report.prior_quarter is None
    assert (report.quarter.fiscal_year, report.quarter.fiscal_quarter) == (2027, 2)
    # The rest of the report is still written and cited.
    assert report.section("drivers").markdown.startswith("- Data center demand [1]")
    assert report.market_data_available is True
    done = next(
        e for e in events if e["agent"] == "transcripts" and e["state"] == "done"
    )
    assert done["summary"] == "2 passages from Q2 FY2027 (no comparable prior quarter)"
    researcher_prompt = model.seen[TRANSCRIPT_KEY][0][0].text
    assert '"## Drivers", "## Guidance", "## Risks"' in researcher_prompt
    assert "Raised / improved" not in researcher_prompt  # no comparison rules
    assert (
        "No comparable earlier call is indexed" in model.seen[TRANSCRIPT_KEY][0][1].text
    )
    assert NO_COMPARISON in seen[0][0].text  # the writer was told


def test_an_uncomparable_ticker_without_a_known_latest_quarter_fails(deps) -> None:
    deps.comparison().compare.return_value = uncomparable()
    model = ByPromptModel(scripts=research_script())

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writer()), latest=None)

    assert error.value.code == "not_indexed"


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


# --- "What changed" must cite the earlier quarter -------------------------------
# The comparison registers [1][2] from Q2 FY2027 and [3][4] from Q1 FY2027.

NOTES_WITHOUT_PRIOR = TRANSCRIPT_NOTES.replace(
    "### Raised / improved\n- Guidance rose from Q1 FY2027 [3] to Q2 FY2027 [2].",
    "### New\n- Newly discussed in Q2 FY2027 [2].",
)
DRAFT_WITHOUT_PRIOR = DRAFT.model_copy(
    update={
        "changes": "### New\n- Newly discussed [2].\n\nRaised / improved, Lowered / "
        "worse, No longer mentioned, Unchanged: nothing found in the retrieved "
        "passages."
    }
)


def writers(*drafts: ReportDraft, seen: list | None = None):
    """A writer that returns ``drafts`` in turn (the last one from then on)."""
    calls = [0]

    def respond(messages: list[BaseMessage]) -> dict:
        if seen is not None:
            seen.append(messages)
        draft = drafts[min(calls[0], len(drafts) - 1)]
        calls[0] += 1
        return {"raw": ai("{...}", usage=(6000, 1500)), "parsed": draft}

    return RunnableLambda(respond)


def researcher_replies(*notes: str) -> dict[str, list[AIMessage]]:
    """One search, then each of ``notes`` as successive answers."""
    first = research_script()[TRANSCRIPT_KEY][0]
    return research_script(
        **{TRANSCRIPT_KEY: [first, *(ai(n, usage=(3000, 400)) for n in notes)]}
    )


def test_notes_that_compare_nothing_get_one_corrective_turn(deps) -> None:
    model = ByPromptModel(
        scripts=researcher_replies(NOTES_WITHOUT_PRIOR, TRANSCRIPT_NOTES)
    )
    _, final, _ = run(make_agents(deps, model, writer()))

    research = final["transcripts"]
    assert research.notes == TRANSCRIPT_NOTES
    assert model.calls[TRANSCRIPT_KEY] == 3  # search, notes, corrected notes
    correction = model.seen[TRANSCRIPT_KEY][-1][-1].text
    assert "cite no Q1 FY2027 passage" in correction
    assert "[3] [4]" in correction
    runs = {r.agent: r for r in final["runs"]}
    assert runs["transcripts"].model_calls == 3


def test_notes_that_still_compare_nothing_show_the_writer_the_earlier_quarter(
    deps,
) -> None:
    seen: list = []
    model = ByPromptModel(scripts=researcher_replies(NOTES_WITHOUT_PRIOR))
    _, final, turn = run(make_agents(deps, model, writer(seen=seen)))

    assert model.calls[TRANSCRIPT_KEY] == 3  # one correction, no more
    assert final["transcripts"].passage_ids[-2:] == [3, 4]
    task = seen[0][1].text
    assert '<passage id="3"' in task and '<passage id="4"' in task
    # The writer compared with Q1 FY2027 [3], so the report ships.
    report = assemble(final, turn)
    assert {(c.fiscal_year, c.fiscal_quarter) for c in report.citations} >= {(2027, 1)}


def test_earlier_passages_fit_within_the_writer_cap() -> None:
    assert with_prior_passages([1, 2, 5, 6], [3, 4], limit=4) == [1, 2, 3, 4]
    assert with_prior_passages([1, 3], [3, 4], limit=24) == [1, 3, 4]
    assert len(with_prior_passages(list(range(30)), list(range(40, 60)), 24)) == 24


def test_a_draft_that_compares_nothing_is_written_once_more(deps) -> None:
    seen: list = []
    model = ByPromptModel(scripts=research_script())
    _, final, turn = run(
        make_agents(deps, model, writers(DRAFT_WITHOUT_PRIOR, DRAFT, seen=seen))
    )

    assert len(seen) == 2
    correction = seen[1][-1].text
    assert "cited no Q1 FY2027 passage" in correction and "[3]" in correction
    assert final["draft"] == DRAFT
    runs = {r.agent: r for r in final["runs"]}
    assert runs["writer"].model_calls == 2 and runs["writer"].input_tokens == 12000
    assert assemble(final, turn).sections[3].markdown.count("[") >= 2


def test_a_report_that_still_compares_nothing_fails_retryably(deps) -> None:
    model = ByPromptModel(scripts=research_script())

    with pytest.raises(ReportError) as error:
        run(make_agents(deps, model, writers(DRAFT_WITHOUT_PRIOR)))

    assert error.value.code == COMPARISON_FAILED == "comparison_failed"
    assert error.value.retryable is True
    assert error.value.message == "Couldn't compare with Q1 FY2027. Please try again."


def test_no_earlier_passages_means_no_comparison(deps) -> None:
    deps.comparison().compare.return_value = comparison(
        themes=[
            ThemePassages(
                key="guidance",
                label="Guidance and outlook",
                current=[comparison_passage(1, 2), comparison_passage(2, 2)],
                prior=[],
            )
        ]
    )
    model = ByPromptModel(scripts=research_script())
    _, final, turn = run(make_agents(deps, model, writer()))

    assert final["transcripts"].prior is None
    report = assemble(final, turn)
    assert report.comparison_available is False
    assert report.sections[3].markdown == NO_COMPARISON


def test_the_researcher_pairs_figures_and_writes_no_placeholders() -> None:
    from app.services.report.prompts import transcript_system

    system = transcript_system(
        company="Microsoft Corporation",
        ticker="MSFT",
        today=TODAY,
        current="Q4 FY2026",
        prior="Q3 FY2026",
        searches=3,
    )

    assert "go through the Q3 FY2026 passages and pair each figure" in system
    assert "never write a placeholder bullet" in system
