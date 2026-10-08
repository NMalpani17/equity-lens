"""The analyst agent: a LangGraph tool-calling agent streamed as chat events.

One call to :meth:`ChatService.stream_turn` runs one turn:

guardrails -> turn context -> MCP tools (per-turn client) -> create_agent
with step limits -> stream tokens and tool progress -> validate citations ->
classify the finish (complete / truncated / blocked / empty) -> ``done``.

If the consumer stops iterating (the client disconnected), the generator is
closed, which cancels the in-flight model request.
"""

import asyncio
import contextlib
import logging
import time
import warnings
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastmcp import Client, FastMCP
from langchain.agents import create_agent
from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from app.config import Settings
from app.localtime import DEFAULT_TIME_ZONE, zone
from app.models.chat import (
    ChatChart,
    ChatHistoryMessage,
    ChatTurnRequest,
    Citation,
    ToolCallSummary,
    TurnStatus,
)
from app.services.observability.masking import (
    portfolio_values,
    set_turn_sensitive_values,
)
from app.services.observability.tracing import NoopTracer, Tracer, TurnTrace

from .charts import MAX_CHARTS_PER_TURN, build_chart, chart_key
from .citations import validate_citations
from .context import TURN_META_KEY, TurnContext, TurnRegistry
from .errors import classify_model_error
from .formatting import tidy_answer
from .guardrails import Verdict, check_message, ensure_advice_note
from .progress import safe_args, tool_label, tool_summary
from .prompt import build_system_prompt

with warnings.catch_warnings():
    # langchain.mcp is marked beta; the version is pinned in requirements.txt.
    warnings.simplefilter("ignore")
    from langchain.mcp import MCPAdapter

logger = logging.getLogger(__name__)

EventType = Literal[
    "token", "tool_start", "tool_progress", "tool_end", "chart", "done", "error"
]

EMPTY_REPLY = (
    "I couldn't produce an answer to that. Please try rephrasing or narrowing "
    "the question."
)
BLOCKED_REPLY = (
    "I can't help with that request. Try asking about a company, its earnings, "
    "the markets, or your portfolio."
)
TRUNCATED_NOTE = (
    "_The answer was cut off at the length limit. Ask a narrower follow-up for "
    "the rest._"
)
STEP_LIMIT_REPLY = (
    "I reached my research step limit before finishing. Try a more specific "
    "question (one company or one quarter at a time)."
)
_BLOCK_REASONS = {
    "SAFETY",
    "RECITATION",
    "PROHIBITED_CONTENT",
    "BLOCKLIST",
    "SPII",
    "IMAGE_SAFETY",
}
_MAX_TOKEN_REASONS = {"MAX_TOKENS", "length", "max_tokens"}
_HISTORY_MESSAGE_CHARS = 4000
# Only answers that went through keep the turn's charts.
_CHART_STATUSES = {"complete", "truncated"}


@dataclass(frozen=True)
class ChatEvent:
    type: EventType
    data: dict[str, Any]


@dataclass
class _PlacedChart:
    """A chart, placed by the tool call that first produced it.

    Parallel tool calls finish in any order, so charts are ordered by when the
    model issued the calls (``position``), not by when results arrived. A
    repeated chart keeps its first position but shows the data of the latest
    issued call (``source``), whichever finished last.
    """

    position: int
    source: int
    chart: ChatChart


@dataclass
class _TurnState:
    tool_calls: dict[str, ToolCallSummary] = field(default_factory=dict)
    # Tool call id -> the order the model issued it in.
    call_order: dict[str, int] = field(default_factory=dict)
    citations: list[Citation] = field(default_factory=list)
    # Chart key -> placed chart; a repeated chart replaces the earlier one in place.
    charts: dict[str, _PlacedChart] = field(default_factory=dict)
    final: AIMessage | None = None
    ended_on_tool_calls: bool = False
    input_tokens: int = 0
    output_tokens: int = 0
    # Final status for tracing ("error" if the turn raised).
    status: str | None = None
    trace_id: str | None = None


async def _decline_elicitation(*_: Any) -> Any:
    """Our tools never ask for input; refuse rather than interrupt the run."""
    raise RuntimeError("elicitation is not supported")


async def merge_progress(
    stream: AsyncIterator[Any], labels: asyncio.Queue[str]
) -> AsyncIterator[tuple[str, Any]]:
    """Yield ("chunk", item) from ``stream`` and ("progress", label) as they arrive.

    Ends when the stream ends. Closing this generator cancels the pending
    stream read, so a client disconnect still cancels the model call.
    """
    iterator = stream.__aiter__()
    next_chunk = asyncio.ensure_future(iterator.__anext__())
    next_label = asyncio.ensure_future(labels.get())
    try:
        while True:
            done, _ = await asyncio.wait(
                {next_chunk, next_label}, return_when=asyncio.FIRST_COMPLETED
            )
            if next_label in done:
                yield "progress", next_label.result()
                next_label = asyncio.ensure_future(labels.get())
            if next_chunk in done:
                try:
                    chunk = next_chunk.result()
                except StopAsyncIteration:
                    return
                yield "chunk", chunk
                next_chunk = asyncio.ensure_future(iterator.__anext__())
    finally:
        next_label.cancel()
        if not next_chunk.done():
            next_chunk.cancel()
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                await next_chunk
        aclose = getattr(iterator, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()


_STREAM_BUFFER = 64


async def iterate_in_scope(
    stream: AsyncIterator[Any], scope: Callable[[], contextlib.AbstractContextManager]
) -> AsyncIterator[Any]:
    """Drive ``stream`` from one producer task that holds ``scope``.

    Callbacks and graph nodes copy the context of the task running the graph,
    so entering the trace scope there gives every span of the run the trace
    attributes. Entering and leaving it in that one task keeps context tokens
    out of this generator, which yields across tasks. Closing this generator
    cancels the producer, which closes the stream (cancelling the model call).
    """
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=_STREAM_BUFFER)

    async def produce() -> None:
        try:
            with scope():
                async for item in stream:
                    await queue.put(("item", item))
            await queue.put(("end", None))
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # handed to the consumer to re-raise
            await queue.put(("error", exc))
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                with contextlib.suppress(Exception):
                    await aclose()

    producer = asyncio.create_task(produce())
    try:
        while True:
            kind, value = await queue.get()
            if kind == "end":
                return
            if kind == "error":
                raise value
            yield value
    finally:
        if not producer.done():
            producer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await producer


class TurnClient(Client):
    """FastMCP client that tags every tool call with the turn id (call meta)."""

    def __init__(self, server: FastMCP, *, turn_id: str) -> None:
        super().__init__(server, elicitation_handler=_decline_elicitation)
        self.turn_id = turn_id

    async def call_tool(self, name: str, arguments: dict | None = None, **kwargs: Any):
        meta = dict(kwargs.pop("meta", None) or {})
        meta[TURN_META_KEY] = self.turn_id
        return await super().call_tool(name, arguments, meta=meta, **kwargs)


def trim_history(
    history: list[ChatHistoryMessage], *, max_messages: int, max_tokens: int
) -> list[dict[str, str]]:
    """Newest final messages that fit the message and (estimated) token budget."""
    kept: list[dict[str, str]] = []
    budget = max_tokens * 4  # ~4 characters per token
    for message in reversed(history[-max_messages:] if max_messages else []):
        content = message.content.strip()[:_HISTORY_MESSAGE_CHARS]
        if not content:
            continue
        if len(content) > budget:
            break
        budget -= len(content)
        kept.append({"role": message.role, "content": content})
    kept.reverse()
    # The model expects the conversation to open with a user message.
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def _finish_reason(message: AIMessage | None) -> str | None:
    if message is None:
        return None
    meta = message.response_metadata or {}
    reason = meta.get("finish_reason") or meta.get("stop_reason")
    feedback = meta.get("prompt_feedback") or {}
    if isinstance(feedback, dict) and feedback.get("block_reason"):
        return "SAFETY"
    return str(reason) if reason else None


class ChatService:
    """Runs analyst chat turns.

    ``registry`` must be the registry the MCP tools read (``turn_registry``),
    since tools resolve the turn's portfolio and citation numbering from it.
    """

    def __init__(
        self,
        settings: Settings,
        model_factory: Callable[[], BaseChatModel],
        mcp_server: FastMCP,
        registry: TurnRegistry,
        today: Callable[[ZoneInfo], date] = lambda tz: datetime.now(tz).date(),
        tracer: Tracer | None = None,
    ) -> None:
        self._settings = settings
        self._model_factory = model_factory
        self._mcp = mcp_server
        self._registry = registry
        self._today = today
        self._tracer: Tracer = tracer or NoopTracer()

    async def stream_turn(
        self, request: ChatTurnRequest, *, trace_tags: Sequence[str] = ()
    ) -> AsyncIterator[ChatEvent]:
        """Run one turn. ``trace_tags`` are added to the trace (e.g. evals)."""
        started = time.perf_counter()
        tags = ["chat", *(["demo"] if request.is_anonymous else []), *trace_tags]
        guard = check_message(request.message)
        if guard.verdict is not Verdict.ALLOW:
            logger.info("chat guard: %s", guard.verdict.value)
            state = _TurnState(status="refused")
            state.trace_id = self._tracer.record_event(
                user_id=request.user_id,
                session_id=request.conversation_id,
                name="chat-turn",
                input=request.message,
                output=guard.reply,
                tags=[*tags, "guardrail"],
                metadata={"guard": guard.verdict.value},
            )
            self._record_status(state)
            yield ChatEvent("token", {"text": guard.reply})
            yield ChatEvent("done", self._done(guard.reply or "", "refused", state))
            return

        turn = TurnContext(
            user_id=request.user_id,
            is_anonymous=request.is_anonymous,
            today=request.today or self._today(zone(request.time_zone)),
            time_zone=request.time_zone or DEFAULT_TIME_ZONE,
            portfolio=request.portfolio,
            question=request.message,
        )
        self._registry.register(turn)
        state = _TurnState()
        if self._tracer.enabled:
            set_turn_sensitive_values(portfolio_values(request.portfolio))
        trace = self._tracer.start_turn(
            user_id=request.user_id,
            session_id=request.conversation_id,
            tags=tags,
            metadata={
                "model": self._settings.chat_model,
                "has_portfolio": str(
                    bool(request.portfolio and request.portfolio.positions)
                ),
                "history_messages": str(len(request.history)),
            },
        )
        try:
            async for event in self._run_agent(
                request, turn, state, guard.advice_request, trace
            ):
                yield event
        except Exception as exc:  # model/provider failures end the turn cleanly
            state.status = "error"
            error = classify_model_error(exc)
            log = logger.warning if error.expected else logger.exception
            log("chat turn failed (%s): %s", error.code, exc)
            yield ChatEvent(
                "error",
                {
                    "code": error.code,
                    "message": error.message,
                    "retryable": error.retryable,
                },
            )
        finally:
            self._registry.discard(turn.turn_id)
            state.trace_id = state.trace_id or trace.trace_id
            self._record_status(state)
            if self._tracer.enabled:
                set_turn_sensitive_values(None)
            logger.info(
                "chat turn",
                extra={
                    "fields": {
                        "event": "chat_turn",
                        "tool_calls": [t.name for t in state.tool_calls.values()],
                        "input_tokens": state.input_tokens,
                        "output_tokens": state.output_tokens,
                        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                        "status": state.status,
                        "trace_id": state.trace_id,
                    }
                },
            )

    async def _run_agent(
        self,
        request: ChatTurnRequest,
        turn: TurnContext,
        state: _TurnState,
        advice_request: bool,
        trace: TurnTrace,
    ) -> AsyncIterator[ChatEvent]:
        settings = self._settings
        messages = trim_history(
            request.history,
            max_messages=settings.chat_history_max_messages,
            max_tokens=settings.chat_history_max_tokens,
        )
        messages.append({"role": "user", "content": request.message})

        async with MCPAdapter(TurnClient(self._mcp, turn_id=turn.turn_id)) as adapter:
            tools = await adapter.list_tools()
            agent = create_agent(
                self._model_factory(),
                tools,
                system_prompt=build_system_prompt(
                    turn.today,
                    time_zone=turn.time_zone,
                    advice_request=advice_request,
                    is_anonymous=request.is_anonymous,
                ),
                middleware=[
                    ModelCallLimitMiddleware(
                        run_limit=settings.chat_max_model_calls, exit_behavior="end"
                    ),
                    ToolCallLimitMiddleware(
                        run_limit=settings.chat_max_tool_calls, exit_behavior="continue"
                    ),
                ],
            )
            stream = agent.astream(
                {"messages": messages},
                stream_mode=["messages", "updates"],
                version="v2",
                config=trace.config,  # tracing callbacks + trace attributes
            )
            # Tools report progress (e.g. while waiting for indexing) through
            # the turn; merge it with the model/tool stream as it happens.
            loop = asyncio.get_running_loop()
            labels: asyncio.Queue[str] = asyncio.Queue()
            turn.progress = lambda label: loop.call_soon_threadsafe(
                labels.put_nowait, label
            )
            try:
                # The producer task holds the trace scope for the whole run.
                chunks = iterate_in_scope(stream, trace.scope)
                async for kind, item in merge_progress(chunks, labels):
                    if kind == "progress":
                        event = self._on_progress(item, state)
                        if event:
                            yield event
                    else:
                        for event in self._handle_chunk(item, state):
                            yield event
            finally:
                turn.progress = None

        content, status = self._finalize(turn, state, advice_request)
        state.status = status
        state.trace_id = trace.trace_id
        yield ChatEvent("done", self._done(content, status, state))

    def _handle_chunk(
        self, chunk: dict[str, Any], state: _TurnState
    ) -> list[ChatEvent]:
        if chunk["type"] == "messages":
            message, metadata = chunk["data"]
            if (
                isinstance(message, AIMessageChunk)
                and metadata.get("langgraph_node") == "model"
                and not message.tool_call_chunks
                and message.text
            ):
                return [ChatEvent("token", {"text": message.text})]
            return []

        events: list[ChatEvent] = []
        for node, update in (chunk["data"] or {}).items():
            node_messages = (
                (update or {}).get("messages", []) if isinstance(update, dict) else []
            )
            for message in node_messages:
                # Middleware (e.g. the model-call limit) may inject its own
                # AIMessage; only the model node produces answers or tool calls.
                if isinstance(message, AIMessage) and node == "model":
                    events.extend(self._on_ai_message(message, state))
                elif isinstance(message, ToolMessage) and node == "tools":
                    events.extend(self._on_tool_message(message, state))
        return events

    def _on_ai_message(self, message: AIMessage, state: _TurnState) -> list[ChatEvent]:
        usage = message.usage_metadata or {}
        state.input_tokens += int(usage.get("input_tokens", 0))
        state.output_tokens += int(usage.get("output_tokens", 0))
        if not message.tool_calls:
            state.final = message
            state.ended_on_tool_calls = False
            return []
        state.ended_on_tool_calls = True
        events = []
        for call in message.tool_calls:
            call_id = call.get("id") or f"call-{len(state.tool_calls) + 1}"
            args = safe_args(call.get("args") or {})
            summary = ToolCallSummary(
                id=call_id,
                name=call["name"],
                label=tool_label(call["name"], args),
                args=args,
            )
            state.tool_calls[call_id] = summary
            state.call_order.setdefault(call_id, len(state.call_order))
            events.append(
                ChatEvent(
                    "tool_start",
                    summary.model_dump(include={"id", "name", "label", "args"}),
                )
            )
        return events

    def _on_progress(self, label: str, state: _TurnState) -> ChatEvent | None:
        """Attach a progress label to the most recently started running tool."""
        running = [t for t in state.tool_calls.values() if t.ok is None]
        if not running:
            return None
        return ChatEvent("tool_progress", {"id": running[-1].id, "label": label})

    def _on_tool_message(
        self, message: ToolMessage, state: _TurnState
    ) -> list[ChatEvent]:
        summary = state.tool_calls.get(message.tool_call_id)
        if summary is None:
            return []
        artifact = message.artifact if isinstance(message.artifact, dict) else {}
        data = artifact.get("structured_content")
        summary.ok = message.status != "error" and (
            data is None or data.get("status") not in ("error",)
        )
        summary.summary = tool_summary(
            summary.name, data, failed=message.status == "error"
        )
        events = [
            ChatEvent(
                "tool_end",
                {
                    "id": summary.id,
                    "name": summary.name,
                    "ok": summary.ok,
                    "summary": summary.summary,
                },
            )
        ]
        chart = self._add_chart(summary, data, state) if summary.ok else None
        if chart is not None:
            events.append(ChatEvent("chart", chart.model_dump(mode="json")))
        return events

    def _add_chart(
        self, summary: ToolCallSummary, data: Any, state: _TurnState
    ) -> ChatChart | None:
        """Chart the tool result if it has a chart (data from the tool only)."""
        chart = build_chart(summary.name, data, f"chart-{summary.id}")
        if chart is None:
            return None
        key = chart_key(chart)
        order = state.call_order.get(summary.id, len(state.call_order))
        placed = state.charts.get(key)
        if placed is None:
            if len(state.charts) >= MAX_CHARTS_PER_TURN:
                return None
            state.charts[key] = _PlacedChart(order, order, chart)
            return chart
        placed.position = min(placed.position, order)
        if order < placed.source:
            # An earlier-issued call finished last: keep the newer data.
            return None
        placed.source, placed.chart = order, chart
        return chart

    def _record_status(self, state: _TurnState) -> None:
        """Tag the trace with how the turn ended (complete, blocked, error…)."""
        self._tracer.score(
            trace_id=state.trace_id,
            name="turn_status",
            value=state.status or "interrupted",
            data_type="CATEGORICAL",
        )

    def _finalize(
        self, turn: TurnContext, state: _TurnState, advice_request: bool
    ) -> tuple[str, TurnStatus]:
        reason = _finish_reason(state.final)
        text = (state.final.text if state.final else "").strip()

        if reason and reason.upper() in _BLOCK_REASONS:
            return BLOCKED_REPLY, "blocked"
        if state.ended_on_tool_calls and not text:
            return STEP_LIMIT_REPLY, "truncated"
        if not text:
            return EMPTY_REPLY, "empty"

        validated = validate_citations(text, turn.sources)
        if validated.dropped:
            logger.warning("dropped unsupported citations: %s", validated.dropped)
        content = tidy_answer(validated.text)
        state.citations = validated.citations
        status: TurnStatus = "complete"
        if reason in _MAX_TOKEN_REASONS:
            content = f"{content}\n\n{TRUNCATED_NOTE}"
            status = "truncated"
        if advice_request:
            content = ensure_advice_note(content)
        return content, status

    def _done(
        self, content: str, status: TurnStatus, state: _TurnState
    ) -> dict[str, Any]:
        return {
            "content": content,
            "status": status,
            "citations": [c.model_dump() for c in state.citations],
            "charts": [
                placed.chart.model_dump(mode="json")
                for placed in sorted(state.charts.values(), key=lambda p: p.position)
            ]
            if status in _CHART_STATUSES
            else [],
            "tool_calls": [t.model_dump() for t in state.tool_calls.values()],
            "usage": {
                "input_tokens": state.input_tokens,
                "output_tokens": state.output_tokens,
            },
            "model": self._settings.chat_model,
            # Internal: lets evals attach scores; the gateway ignores it.
            "trace_id": state.trace_id,
        }
