"""Runs one research report generation and streams it as events.

claim the report row -> per-run MCP tools and turn context -> the agent graph
(inside one Langfuse trace) -> assemble and validate -> save -> ``done``.

The claim is released on any failure or cancellation (the client went away),
so the next request can generate. The report holds nothing user-specific; the
requesting user only appears (hashed) in the trace.
"""

import asyncio
import contextlib
import logging
import time
import warnings
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastmcp import FastMCP

from app.config import Settings, get_settings
from app.errors import AppError
from app.models.report import ReportRequest, ResearchReportContent
from app.models.transcript import parse_period_label
from app.services.chat import mcp_server, tools
from app.services.chat.agent import TurnClient, iterate_in_scope
from app.services.chat.context import TurnContext, TurnRegistry, turn_registry
from app.services.chat.errors import classify_model_error
from app.services.observability.tracing import NoopTracer, Tracer, get_tracer
from app.services.rag.container import get_rag_components
from app.services.rag.repository import TickerRecord
from app.services.rag.search import is_searchable

from .assemble import assemble_report
from .graph import (
    Period,
    ReportAgents,
    ReportError,
    ReportInputs,
    build_report_graph,
    run_report_graph,
)
from .llm import build_research_model, build_writer
from .repository import Claim, ClaimOutcome, ReportRepository

with warnings.catch_warnings():
    # langchain.mcp is marked beta; the version is pinned in requirements.txt.
    warnings.simplefilter("ignore")
    from langchain.mcp import MCPAdapter

logger = logging.getLogger(__name__)

MARKET_TIME_ZONE = "America/New_York"
# The turn's user id: reports are shared, so tools never see the requester.
REPORT_TURN_USER = "research-report"

ReportEventType = Literal["agent", "done", "error"]


@dataclass(frozen=True)
class ReportEvent:
    type: ReportEventType
    data: dict[str, Any]


def _error(code: str, message: str, *, retryable: bool = False) -> ReportEvent:
    return ReportEvent(
        "error", {"code": code, "message": message, "retryable": retryable}
    )


class ReportService:
    def __init__(
        self,
        settings: Settings,
        agents: ReportAgents,
        mcp: FastMCP,
        registry: TurnRegistry,
        repo: Callable[[], ReportRepository],
        ticker_record: Callable[[str], TickerRecord | None],
        tracer: Tracer | None = None,
        today: Callable[[], date] = lambda: datetime.now(
            ZoneInfo(MARKET_TIME_ZONE)
        ).date(),
    ) -> None:
        self._settings = settings
        self._agents = agents
        self._mcp = mcp
        self._registry = registry
        self._repo = repo
        self._ticker_record = ticker_record
        self._tracer: Tracer = tracer or NoopTracer()
        self._today = today

    async def stream(
        self, request: ReportRequest, *, trace_tags: tuple[str, ...] = ()
    ) -> AsyncIterator[ReportEvent]:
        """Generate ``request.ticker``'s report for its latest indexed quarter."""
        if request.is_anonymous:
            yield _error("demo_not_allowed", "Demo accounts can view reports only.")
            return
        ticker = request.ticker
        record = await asyncio.to_thread(self._ticker_record, ticker)
        latest = (
            parse_period_label(record.quarters[0])
            if record and is_searchable(record) and record.quarters
            else None
        )
        if record is None or latest is None:
            yield _error("not_indexed", f"{ticker} has no indexed earnings calls yet.")
            return
        repo = self._repo()
        claim = await self._claim(repo, ticker, latest, request.regenerate_after_days)
        if claim.outcome is ClaimOutcome.IN_PROGRESS:
            yield _error(
                "report_in_progress",
                f"{ticker}'s report is being generated. Check back in a minute.",
                retryable=True,
            )
            return
        if claim.outcome is ClaimOutcome.FRESH:
            yield _error(
                "report_fresh",
                f"{ticker}'s report is less than "
                f"{request.regenerate_after_days} days old.",
            )
            return
        assert claim.generation_id is not None
        run = _Run(claim.generation_id)
        try:
            async with contextlib.aclosing(
                self._generate(request, record, Period(*latest), run, repo, trace_tags)
            ) as events:
                async for event in events:
                    yield event
        finally:
            # Failed, timed out or cancelled (the client went away): free the
            # report now, not after the stale window, so a retry can generate.
            if not run.saved and not run.released:
                self._release(repo, run.generation_id)

    async def _claim(
        self, repo: ReportRepository, ticker: str, latest: tuple[int, int], days: int
    ) -> Claim:
        """Claim the report; if cancelled meanwhile, release once it lands.

        The claim runs in a worker thread and commits even if this coroutine
        is cancelled (the client disconnected), so a claim that lands after
        cancellation is released right away instead of blocking the report
        for the stale window.
        """
        task = asyncio.ensure_future(
            asyncio.to_thread(
                repo.claim,
                ticker,
                *latest,
                regenerate_after=timedelta(days=days),
                stale_after=timedelta(minutes=self._settings.report_lock_stale_minutes),
            )
        )
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            task.add_done_callback(lambda done: self._release_landed(repo, done))
            raise

    def _release_landed(self, repo: ReportRepository, task: asyncio.Future) -> None:
        if task.cancelled() or task.exception() is not None:
            return
        claim: Claim = task.result()
        if claim.outcome is ClaimOutcome.CLAIMED and claim.generation_id:
            self._release(repo, claim.generation_id)

    @staticmethod
    def _release(repo: ReportRepository, generation_id: str) -> None:
        try:
            repo.release(generation_id)
        except Exception:
            logger.warning(
                "could not release report claim %s; it expires after the stale window",
                generation_id,
                exc_info=True,
            )

    async def _generate(
        self,
        request: ReportRequest,
        record: TickerRecord,
        latest: Period,
        run: "_Run",
        repo: ReportRepository,
        trace_tags: tuple[str, ...],
    ) -> AsyncIterator[ReportEvent]:
        generation_id = run.generation_id
        settings = self._settings
        ticker = request.ticker
        company = record.company_name or ticker
        started = time.perf_counter()
        turn = TurnContext(
            user_id=REPORT_TURN_USER,
            is_anonymous=False,
            today=self._today(),
            portfolio=None,
            time_zone=MARKET_TIME_ZONE,
            question=f"{company} earnings call: results, guidance and outlook",
        )
        self._registry.register(turn)
        trace = self._tracer.start_turn(
            user_id=request.user_id,
            session_id=generation_id,
            name="research-report",
            tags=["report", ticker, *trace_tags],
            metadata={
                "ticker": ticker,
                "quarter": latest.label,
                "research_model": settings.report_research_model,
                "writer_model": settings.report_writer_model,
            },
        )
        # Stays "interrupted" if the client goes away mid-run.
        status = "interrupted"
        error: ReportEvent | None = None
        content: ResearchReportContent | None = None
        try:
            async with asyncio.timeout(settings.report_timeout_seconds):
                state: dict[str, Any] = {}
                async with MCPAdapter(
                    TurnClient(self._mcp, turn_id=turn.turn_id)
                ) as adapter:
                    graph = build_report_graph(
                        self._agents,
                        ReportInputs(
                            ticker, company, turn.today, latest_quarter=latest
                        ),
                        turn,
                        await adapter.list_tools(),
                    )
                    config = {**trace.config, "run_name": "research-report"}
                    stream = run_report_graph(graph, config)
                    async for kind, item in iterate_in_scope(stream, trace.scope):
                        if kind == "progress":
                            yield ReportEvent("agent", item)
                        else:
                            state = item
                content = assemble_report(
                    state,
                    ticker=ticker,
                    company_name=company,
                    registry=turn.sources,
                    settings=settings,
                )
            generated_at = await asyncio.to_thread(
                repo.save,
                generation_id,
                content=content.model_dump(mode="json"),
                company_name=company,
                trace_id=trace.trace_id,
            )
            if generated_at is None:
                raise ReportError(
                    "report_lost_lock",
                    "Another generation replaced this one. Please reload.",
                    retryable=True,
                )
            run.saved = True
            status = "complete"
            yield ReportEvent(
                "done",
                {
                    "report": content.model_dump(mode="json"),
                    "fiscal_year": latest.fiscal_year,
                    "fiscal_quarter": latest.fiscal_quarter,
                    "generated_at": generated_at.isoformat() + "Z",
                    "usage": _usage(content),
                    # Internal: lets evals attach scores; the gateway ignores it.
                    "trace_id": trace.trace_id,
                },
            )
        except ReportError as exc:
            status = exc.code
            logger.warning("report %s failed (%s): %s", ticker, exc.code, exc.message)
            error = _error(exc.code, exc.message, retryable=exc.retryable)
        except TimeoutError:
            status = "timeout"
            logger.warning("report %s timed out", ticker)
            error = _error(
                "report_timeout",
                "The report took too long. Please try again.",
                retryable=True,
            )
        except Exception as exc:  # model/provider failures end the run cleanly
            model_error = classify_model_error(exc)
            status = model_error.code
            log = logger.warning if model_error.expected else logger.exception
            log("report %s failed (%s): %s", ticker, model_error.code, exc)
            error = _error(
                model_error.code, model_error.message, retryable=model_error.retryable
            )
        finally:
            # Release before the error goes out, so a client that retries as
            # soon as it sees the error isn't told the report is in progress.
            if not run.saved:
                self._release(repo, generation_id)
                run.released = True
            self._registry.discard(turn.turn_id)
            self._tracer.score(
                trace_id=trace.trace_id,
                name="report_status",
                value=status,
                data_type="CATEGORICAL",
            )
            logger.info(
                "research report",
                extra={
                    "fields": {
                        "event": "research_report",
                        "ticker": ticker,
                        "quarter": latest.label,
                        "status": status,
                        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                        "trace_id": trace.trace_id,
                        **(_usage(content) if content else {}),
                    }
                },
            )
        if error is not None:
            yield error


@dataclass
class _Run:
    """One generation's claim: saved (content stored) or released (freed)."""

    generation_id: str
    saved: bool = False
    released: bool = False


def _usage(content: ResearchReportContent) -> dict[str, Any]:
    return {
        "input_tokens": sum(a.input_tokens for a in content.agents),
        "output_tokens": sum(a.output_tokens for a in content.agents),
        "cost_usd": round(sum(a.cost_usd for a in content.agents), 6),
    }


def default_agents(settings: Settings) -> ReportAgents:
    return ReportAgents(
        settings=settings,
        research_model=lambda: build_research_model(settings),
        writer=lambda: build_writer(settings),
        compare=lambda turn, ticker: tools.compare_quarters(
            mcp_server.tool_deps(), turn, ticker=ticker
        ),
    )


@lru_cache
def get_report_service() -> ReportService:
    settings = get_settings()
    missing = settings.report_missing_settings
    if missing:
        raise AppError(
            503,
            "report_not_configured",
            "research reports are not configured",
            {"missing": missing},
        )
    return ReportService(
        settings,
        default_agents(settings),
        mcp_server.mcp,
        turn_registry,
        repo=lambda: ReportRepository(get_rag_components().pool),
        ticker_record=lambda ticker: get_rag_components().repo.get_ticker(ticker),
        tracer=get_tracer(),
    )
