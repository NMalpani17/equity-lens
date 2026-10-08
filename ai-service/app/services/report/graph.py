"""The research report graph: two researchers in parallel, then the writer.

    START ─┬─▶ transcript_researcher ─┐
           └─▶ market_analyst ────────┴─▶ writer ─▶ END

A fixed orchestration of specialized agents, not a supervisor: the edges
never change and no model decides who runs next. Each agent has its own
prompt, its own tools and its own step limits:

- transcript_researcher (research model): calls the existing
  QuarterComparisonService (through the compare_quarters tool logic, without
  an LLM step), then runs a tool-calling agent with search_transcripts only,
  and returns cited notes. If the latest call has no comparable earlier call,
  it researches the latest call alone and the report states that no
  comparison is available.
- market_analyst (research model): a tool-calling agent with get_quote and
  get_price_history; its tool results become [Dn] data sources and the chart.
  If it fails, the report still ships with price data marked unavailable.
- writer (writer model, no tools): turns both sets of notes, the passages the
  notes cite and the data sources into six sections (structured output).

Nodes report progress through LangGraph's custom stream ("agent" events),
and each node is one span in the run's trace.
"""

import logging
import operator
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Annotated, Any, TypedDict

from langchain.agents import create_agent
from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.runnables import Runnable, RunnableConfig, RunnableLambda
from langchain_core.tools import BaseTool
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.config import Settings
from app.models.chat import PriceChart
from app.models.report import AgentName, AgentRun, DataSource, ReportDraft
from app.services.chat.charts import build_chart
from app.services.chat.citations import cited_ids
from app.services.chat.context import TurnContext
from app.services.chat.transcripts import SearchOutput
from app.services.evals.pricing import cost_usd, model_id

from . import prompts
from .sources import DataSourceRegistry

logger = logging.getLogger(__name__)

TRANSCRIPT_TOOLS = ("search_transcripts",)
MARKET_TOOLS = ("get_quote", "get_price_history")
NODES: dict[AgentName, str] = {
    "transcripts": "transcript_researcher",
    "market": "market_analyst",
    "writer": "writer",
}
LABELS: dict[AgentName, str] = {
    "transcripts": "Researching transcripts…",
    "market": "Analyzing price data…",
    "writer": "Writing report…",
}
# The same steps once finished.
DONE_LABELS: dict[AgentName, str] = {
    "transcripts": "Researched transcripts",
    "market": "Analyzed price data",
    "writer": "Wrote report",
}
CHART_PERIOD = "6mo"


class ReportError(Exception):
    """A report can't be produced; ``code`` and ``message`` go to the client."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class Period:
    fiscal_year: int
    fiscal_quarter: int

    @property
    def label(self) -> str:
        return f"Q{self.fiscal_quarter} FY{self.fiscal_year}"

    @classmethod
    def of(cls, data: dict[str, Any]) -> "Period":
        return cls(int(data["fiscal_year"]), int(data["fiscal_quarter"]))


@dataclass(frozen=True)
class ReportInputs:
    ticker: str
    company_name: str
    today: date
    # The newest indexed call; the report's quarter when no comparison exists.
    latest_quarter: Period | None = None


@dataclass
class TranscriptResearch:
    notes: str
    passage_ids: list[int]
    current: Period
    # None when the latest call has no comparable earlier call.
    prior: Period | None


@dataclass
class MarketResearch:
    notes: str = ""
    sources: list[DataSource] = field(default_factory=list)
    chart: PriceChart | None = None

    @property
    def ok(self) -> bool:
        return bool(self.sources)


class ReportState(TypedDict, total=False):
    transcripts: TranscriptResearch
    market: MarketResearch
    draft: ReportDraft
    # Parallel nodes each append their own run.
    runs: Annotated[list[AgentRun], operator.add]


@dataclass(frozen=True)
class ReportAgents:
    """Models and the comparison step, swappable in tests.

    ``writer`` returns a runnable that maps messages to
    ``{"raw": AIMessage, "parsed": ReportDraft | None}`` (structured output
    with ``include_raw``).
    """

    settings: Settings
    research_model: Callable[[], BaseChatModel]
    writer: Callable[[], Runnable]
    compare: Callable[[TurnContext, str], SearchOutput]


def final_text(messages: Sequence[BaseMessage]) -> str:
    """The last model answer that isn't a tool call (empty if it ran out)."""
    for message in reversed(messages):
        if isinstance(message, AIMessage) and not message.tool_calls:
            return message.text.strip()
    return ""


def record_usage(run: AgentRun, messages: Sequence[BaseMessage]) -> None:
    for message in messages:
        if isinstance(message, AIMessage):
            usage = message.usage_metadata or {}
            run.input_tokens += int(usage.get("input_tokens", 0))
            run.output_tokens += int(usage.get("output_tokens", 0))
            run.model_calls += 1
        elif isinstance(message, ToolMessage):
            run.tool_calls += 1
    run.cost_usd = round(cost_usd(run.model, run.input_tokens, run.output_tokens), 6)


def _limits(model_calls: int, tool_calls: int) -> list[Any]:
    return [
        ModelCallLimitMiddleware(run_limit=model_calls, exit_behavior="end"),
        ToolCallLimitMiddleware(run_limit=tool_calls, exit_behavior="continue"),
    ]


def _pick_tools(tools: Sequence[BaseTool], names: Sequence[str]) -> list[BaseTool]:
    by_name = {t.name: t for t in tools}
    missing = [n for n in names if n not in by_name]
    if missing:
        raise ReportError("tools_unavailable", f"missing tools {missing}")
    return [by_name[n] for n in names]


def _tool_data(message: ToolMessage) -> dict[str, Any] | None:
    artifact = message.artifact if isinstance(message.artifact, dict) else {}
    data = artifact.get("structured_content")
    return data if isinstance(data, dict) else None


class _Progress:
    """Emits one agent's running / done / failed events and times it."""

    def __init__(self, agent: AgentName, model: str) -> None:
        self.agent = agent
        self.run = AgentRun(agent=agent, model=model_id(model), status="failed")
        self._emit = get_stream_writer()
        self._started = time.perf_counter()
        self._send("running", LABELS[agent])

    def _send(self, state: str, label: str, summary: str | None = None) -> None:
        event: dict[str, Any] = {"agent": self.agent, "state": state, "label": label}
        if summary:
            event["summary"] = summary
        self._emit(event)

    def done(self, summary: str) -> AgentRun:
        self.run.status = "ok"
        self._finish()
        self._send("done", DONE_LABELS[self.agent], summary)
        return self.run

    def failed(self, summary: str) -> AgentRun:
        self._finish()
        self._send("failed", LABELS[self.agent], summary)
        return self.run

    def _finish(self) -> None:
        self.run.latency_ms = round((time.perf_counter() - self._started) * 1000, 1)


def build_report_graph(
    agents: ReportAgents,
    inputs: ReportInputs,
    turn: TurnContext,
    tools: Sequence[BaseTool],
) -> CompiledStateGraph:
    """The compiled graph for one report run (tools bound to ``turn``)."""
    settings = agents.settings
    transcript_tools = _pick_tools(tools, TRANSCRIPT_TOOLS)
    market_tools = _pick_tools(tools, MARKET_TOOLS)

    async def transcript_researcher(
        state: ReportState, config: RunnableConfig
    ) -> ReportState:
        progress = _Progress("transcripts", settings.report_research_model)
        try:
            comparison = await RunnableLambda(
                lambda ticker: agents.compare(turn, ticker), name="compare_quarters"
            ).ainvoke(inputs.ticker, config)
            data = comparison.data
            prior: Period | None = None
            if data.get("status") == "ok":
                current, prior = Period.of(data["current"]), Period.of(data["prior"])
                task = prompts.transcript_task(comparison.text)
            elif inputs.latest_quarter is not None:
                # Degrade like a failed market analyst: the report ships and
                # "What changed" says no comparable prior quarter exists.
                current = inputs.latest_quarter
                task = prompts.transcript_task_without_comparison(
                    str(data.get("message") or "")
                )
            else:
                raise ReportError(
                    "not_indexed", f"{inputs.ticker} has no indexed earnings call."
                )
            agent = create_agent(
                agents.research_model(),
                transcript_tools,
                system_prompt=prompts.transcript_system(
                    company=inputs.company_name,
                    ticker=inputs.ticker,
                    today=inputs.today,
                    current=current.label,
                    prior=prior.label if prior else None,
                    searches=settings.report_transcript_max_tool_calls,
                ),
                middleware=_limits(
                    settings.report_transcript_max_model_calls,
                    settings.report_transcript_max_tool_calls,
                ),
                name="transcript_researcher_agent",
            )
            result = await agent.ainvoke({"messages": [HumanMessage(task)]}, config)
            record_usage(progress.run, result["messages"])
            notes = final_text(result["messages"])
            ids = [i for i in cited_ids(notes) if turn.sources.get(i) is not None]
            if not notes or not ids:
                raise ReportError(
                    "research_failed",
                    "The transcript research found no citable passages.",
                    retryable=True,
                )
        except Exception as exc:
            progress.failed(getattr(exc, "message", "Transcript research failed"))
            raise
        run = progress.done(
            f"{len(ids)} passages from {current.label} and {prior.label}"
            if prior
            else f"{len(ids)} passages from {current.label} "
            "(no comparable prior quarter)"
        )
        return {
            "transcripts": TranscriptResearch(notes, ids, current, prior),
            "runs": [run],
        }

    async def market_analyst(state: ReportState, config: RunnableConfig) -> ReportState:
        progress = _Progress("market", settings.report_research_model)
        research = MarketResearch()
        try:
            agent = create_agent(
                agents.research_model(),
                market_tools,
                system_prompt=prompts.market_system(
                    ticker=inputs.ticker, today=inputs.today
                ),
                middleware=_limits(
                    settings.report_market_max_model_calls,
                    settings.report_market_max_tool_calls,
                ),
                name="market_analyst_agent",
            )
            result = await agent.ainvoke(
                {"messages": [HumanMessage(prompts.market_task(inputs.ticker))]},
                config,
            )
            record_usage(progress.run, result["messages"])
            registry = DataSourceRegistry()
            charts: dict[str, PriceChart] = {}
            for message in result["messages"]:
                if not isinstance(message, ToolMessage) or message.status == "error":
                    continue
                data = _tool_data(message)
                if data is None or registry.add(message.name or "", data) is None:
                    continue
                chart = build_chart(message.name or "", data, "report-price-chart")
                if isinstance(chart, PriceChart):
                    charts[chart.period] = chart
            research = MarketResearch(
                notes=final_text(result["messages"]),
                sources=registry.sources,
                chart=charts.get(CHART_PERIOD) or next(iter(charts.values()), None),
            )
        except Exception:
            # The report still ships, with price data marked unavailable.
            logger.warning("market analyst failed for %s", inputs.ticker, exc_info=True)
        if not research.ok:
            return {
                "market": MarketResearch(),
                "runs": [progress.failed("Price data unavailable")],
            }
        kinds = sorted({s.label.split(",")[0] for s in research.sources})
        run = progress.done(f"{len(research.sources)} data sources: {'; '.join(kinds)}")
        return {"market": research, "runs": [run]}

    async def writer(state: ReportState, config: RunnableConfig) -> ReportState:
        progress = _Progress("writer", settings.report_writer_model)
        try:
            research = state["transcripts"]
            market = state.get("market") or MarketResearch()
            passages = [
                source
                for i in writer_passage_ids(research, settings)
                if (source := turn.sources.get(i)) is not None
            ]
            messages = [
                SystemMessage(
                    prompts.writer_system(
                        company=inputs.company_name,
                        ticker=inputs.ticker,
                        today=inputs.today,
                        current=research.current.label,
                        current_date=next(
                            (
                                p.call_date
                                for p in passages
                                if (p.fiscal_year, p.fiscal_quarter)
                                == (
                                    research.current.fiscal_year,
                                    research.current.fiscal_quarter,
                                )
                            ),
                            None,
                        ),
                        prior=research.prior.label if research.prior else None,
                        market_available=market.ok,
                    )
                ),
                HumanMessage(
                    prompts.writer_task(
                        transcript_notes=research.notes,
                        market_notes=market.notes,
                        passages=passages,
                        data_sources=market.sources,
                    )
                ),
            ]
            output = await agents.writer().ainvoke(messages, config)
            raw = output.get("raw") if isinstance(output, dict) else None
            if isinstance(raw, AIMessage):
                record_usage(progress.run, [raw])
            draft = output.get("parsed") if isinstance(output, dict) else None
            if not isinstance(draft, ReportDraft):
                raise ReportError(
                    "writer_failed",
                    "The report couldn't be written. Please try again.",
                    retryable=True,
                )
        except Exception as exc:
            progress.failed(getattr(exc, "message", "Writing failed"))
            raise
        return {"draft": draft, "runs": [progress.done("6 sections")]}

    graph = StateGraph(ReportState)
    graph.add_node(NODES["transcripts"], transcript_researcher)
    graph.add_node(NODES["market"], market_analyst)
    graph.add_node(NODES["writer"], writer)
    graph.add_edge(START, NODES["transcripts"])
    graph.add_edge(START, NODES["market"])
    # The writer waits for both researchers.
    graph.add_edge([NODES["transcripts"], NODES["market"]], NODES["writer"])
    graph.add_edge(NODES["writer"], END)
    return graph.compile(name="research-report")


def writer_passage_ids(research: TranscriptResearch, settings: Settings) -> list[int]:
    """The passages the writer is shown (and so may cite): those the notes cite."""
    return research.passage_ids[: settings.report_writer_max_passages]


async def run_report_graph(
    graph: CompiledStateGraph, config: RunnableConfig
) -> AsyncIterator[tuple[str, Any]]:
    """Yield ("progress", event) as agents report, then ("state", final state)."""
    final: dict[str, Any] = {}
    async for chunk in graph.astream(
        {"runs": []}, config=config, stream_mode=["custom", "values"], version="v2"
    ):
        if chunk["type"] == "custom":
            yield "progress", chunk["data"]
        elif chunk["type"] == "values":
            final = chunk["data"]
    yield "state", final
