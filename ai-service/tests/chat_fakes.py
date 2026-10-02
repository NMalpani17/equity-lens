"""Shared fixtures for chat tests: search results, portfolios, turn contexts."""

import asyncio
import json
import re
from datetime import UTC, date, datetime
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from app.models.chat import PortfolioPosition, PortfolioSnapshot, PortfolioTotals
from app.models.rag import RagSearchResult
from app.services.chat.context import TurnContext


def search_result(
    i: int, ticker: str = "NVDA", text: str | None = None
) -> RagSearchResult:
    return RagSearchResult(
        id=f"{ticker}#FY2027Q2#{i:04d}",
        text=text or f"Data center revenue grew strongly, passage {i}.",
        score=0.9,
        retrieval_score=0.5,
        rerank_score=0.9,
        ticker=ticker,
        company_name="Nvidia Corp",
        fiscal_year=2027,
        fiscal_quarter=2,
        call_date="2026-08-26",
        speaker="Colette Kress",
        role="CFO",
        section="prepared_remarks",
        chunk_index=i,
        context_header="NVDA (Nvidia Corp) · Q2 FY2027 earnings call",
    )


def portfolio(*positions: PortfolioPosition) -> PortfolioSnapshot:
    value = sum(p.market_value or 0 for p in positions)
    cost = sum(p.cost_basis for p in positions)
    return PortfolioSnapshot(
        positions=list(positions),
        totals=PortfolioTotals(
            market_value=value,
            cost_basis=cost,
            gain_loss=value - cost,
            gain_loss_percent=round((value - cost) / cost * 100, 2) if cost else 0,
        ),
        as_of=datetime(2026, 10, 1, 15, 0, tzinfo=UTC),
    )


def position(ticker: str, shares: float, avg: float, price: float) -> PortfolioPosition:
    return PortfolioPosition(
        ticker=ticker,
        total_shares=shares,
        avg_buy_price=avg,
        cost_basis=shares * avg,
        current_price=price,
        market_value=shares * price,
        gain_loss=shares * (price - avg),
        gain_loss_percent=round((price - avg) / avg * 100, 2),
    )


def turn(snapshot: PortfolioSnapshot | None = None) -> TurnContext:
    return TurnContext(
        user_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        is_anonymous=False,
        today=date(2026, 10, 1),
        portfolio=snapshot,
    )


# --- Scripted chat model -----------------------------------------------------


def ai(
    text: str = "",
    *,
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str = "STOP",
    usage: tuple[int, int] = (100, 20),
) -> AIMessage:
    """A scripted model reply (text or tool calls) with metadata."""
    return AIMessage(
        content=text,
        tool_calls=[
            {"name": c["name"], "args": c.get("args", {}), "id": c.get("id", f"c{i}")}
            for i, c in enumerate(tool_calls or [])
        ],
        response_metadata={"finish_reason": finish_reason},
        usage_metadata={
            "input_tokens": usage[0],
            "output_tokens": usage[1],
            "total_tokens": sum(usage),
        },
    )


class ScriptedChatModel(BaseChatModel):
    """Replays scripted replies, streaming text word by word.

    Records the messages it was sent, whether its stream was cancelled, and the
    tools bound to it. Raises if called more often than scripted.
    """

    script: list[AIMessage]
    token_delay: float = 0.0
    error: BaseException | None = None
    calls: int = 0
    cancelled: bool = False
    seen: list[list[BaseMessage]] = []
    bound_tools: list[str] = []

    model_config = {"arbitrary_types_allowed": True}

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **_: Any) -> "ScriptedChatModel":
        self.bound_tools = [getattr(t, "name", str(t)) for t in tools]
        return self

    def _next(self, messages: list[BaseMessage]) -> AIMessage:
        self.seen.append(list(messages))
        if self.error is not None:
            raise self.error
        if self.calls >= len(self.script):
            raise AssertionError(
                f"model called {self.calls + 1} times; script exhausted"
            )
        reply = self.script[self.calls]
        self.calls += 1
        return reply

    def _generate(self, messages, stop=None, run_manager=None, **_: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._next(messages))])

    async def _astream(self, messages, stop=None, run_manager=None, **_: Any):
        reply = self._next(messages)
        meta = {
            "response_metadata": reply.response_metadata,
            "usage_metadata": reply.usage_metadata,
        }
        if reply.tool_calls:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {
                            "name": c["name"],
                            "args": json.dumps(c["args"]),
                            "id": c["id"],
                            "index": i,
                        }
                        for i, c in enumerate(reply.tool_calls)
                    ],
                    **meta,
                )
            )
            return
        words = re.findall(r"\S+\s*", reply.text) or [""]
        try:
            for i, word in enumerate(words):
                if self.token_delay:
                    await asyncio.sleep(self.token_delay)
                extra = meta if i == len(words) - 1 else {}
                chunk = ChatGenerationChunk(
                    message=AIMessageChunk(content=word, **extra)
                )
                if run_manager:
                    await run_manager.on_llm_new_token(word, chunk=chunk)
                yield chunk
        except (asyncio.CancelledError, GeneratorExit):
            self.cancelled = True
            raise
