"""The analyst agent: a LangGraph tool-calling agent streamed as chat events.

One call to :meth:`ChatService.stream_turn` runs one turn:

guardrails -> turn context -> MCP tools (per-turn client) -> create_agent
with step limits -> stream tokens and tool progress -> validate citations ->
classify the finish (complete / truncated / blocked / empty) -> ``done``.

If the consumer stops iterating (the client disconnected), the generator is
closed, which cancels the in-flight model request.
"""

import logging
import time
import warnings
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal

from fastmcp import Client, FastMCP
from langchain.agents import create_agent
from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from app.config import Settings
from app.models.chat import (
    ChatHistoryMessage,
    ChatTurnRequest,
    Citation,
    ToolCallSummary,
    TurnStatus,
)

from .citations import validate_citations
from .context import TURN_META_KEY, TurnContext, TurnRegistry
from .errors import classify_model_error
from .guardrails import Verdict, check_message, ensure_advice_note
from .progress import safe_args, tool_label, tool_summary
from .prompt import build_system_prompt

with warnings.catch_warnings():
    # langchain.mcp is marked beta; the version is pinned in requirements.txt.
    warnings.simplefilter("ignore")
    from langchain.mcp import MCPAdapter

logger = logging.getLogger(__name__)

EventType = Literal["token", "tool_start", "tool_end", "done", "error"]

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


@dataclass(frozen=True)
class ChatEvent:
    type: EventType
    data: dict[str, Any]


@dataclass
class _TurnState:
    tool_calls: dict[str, ToolCallSummary] = field(default_factory=dict)
    citations: list[Citation] = field(default_factory=list)
    final: AIMessage | None = None
    ended_on_tool_calls: bool = False
    input_tokens: int = 0
    output_tokens: int = 0


async def _decline_elicitation(*_: Any) -> Any:
    """Our tools never ask for input; refuse rather than interrupt the run."""
    raise RuntimeError("elicitation is not supported")


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
        today: Callable[[], date] = lambda: datetime.now(UTC).date(),
    ) -> None:
        self._settings = settings
        self._model_factory = model_factory
        self._mcp = mcp_server
        self._registry = registry
        self._today = today

    async def stream_turn(self, request: ChatTurnRequest) -> AsyncIterator[ChatEvent]:
        started = time.perf_counter()
        guard = check_message(request.message)
        if guard.verdict is not Verdict.ALLOW:
            logger.info("chat guard: %s", guard.verdict.value)
            yield ChatEvent("token", {"text": guard.reply})
            yield ChatEvent(
                "done", self._done(guard.reply or "", "refused", _TurnState())
            )
            return

        turn = TurnContext(
            user_id=request.user_id,
            is_anonymous=request.is_anonymous,
            today=request.today or self._today(),
            portfolio=request.portfolio,
        )
        self._registry.register(turn)
        state = _TurnState()
        try:
            async for event in self._run_agent(
                request, turn, state, guard.advice_request
            ):
                yield event
        except Exception as exc:  # model/provider failures end the turn cleanly
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
            logger.info(
                "chat turn",
                extra={
                    "fields": {
                        "event": "chat_turn",
                        "tool_calls": [t.name for t in state.tool_calls.values()],
                        "input_tokens": state.input_tokens,
                        "output_tokens": state.output_tokens,
                        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                    }
                },
            )

    async def _run_agent(
        self,
        request: ChatTurnRequest,
        turn: TurnContext,
        state: _TurnState,
        advice_request: bool,
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
            )
            async for chunk in stream:
                for event in self._handle_chunk(chunk, state):
                    yield event

        content, status = self._finalize(turn, state, advice_request)
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
            events.append(
                ChatEvent(
                    "tool_start",
                    summary.model_dump(include={"id", "name", "label", "args"}),
                )
            )
        return events

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
        return [
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
        content = validated.text
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
            "tool_calls": [t.model_dump() for t in state.tool_calls.values()],
            "usage": {
                "input_tokens": state.input_tokens,
                "output_tokens": state.output_tokens,
            },
            "model": self._settings.chat_model,
        }
