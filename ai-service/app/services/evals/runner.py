"""Run eval cases through the real chat agent and record what happened."""

import json
import logging
import time
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import ToolMessage

from app.models.chat import (
    ChatTurnRequest,
    PortfolioPosition,
    PortfolioSnapshot,
    PortfolioTotals,
)
from app.services.chat.agent import ChatService
from app.services.observability.tracing import NoopTracer, Tracer, TurnTrace

from .models import EvalCase, ToolCallRecord, TurnRecord

logger = logging.getLogger(__name__)

EVAL_USER_ID = "00000000-0000-4000-8000-0000000e7a15"
_MAX_TOOL_OUTPUT_CHARS = 6000

# (ticker, name, shares, average cost, price) — fixed so answers are checkable.
_DEMO_HOLDINGS = [
    ("NVDA", "NVIDIA Corp", 40, 95.50, 182.00),
    ("AAPL", "Apple Inc", 25, 178.20, 232.00),
    ("MSFT", "Microsoft Corp", 15, 310.00, 505.00),
    ("COST", "Costco Wholesale Corp", 8, 720.00, 915.00),
    ("SBUX", "Starbucks Corp", 30, 98.00, 84.00),
]


def demo_portfolio() -> PortfolioSnapshot:
    """The fixed portfolio every eval turn sees (deterministic math)."""
    positions = [
        PortfolioPosition(
            ticker=ticker,
            name=name,
            total_shares=shares,
            avg_buy_price=avg,
            cost_basis=round(shares * avg, 2),
            current_price=price,
            market_value=round(shares * price, 2),
            gain_loss=round(shares * (price - avg), 2),
            gain_loss_percent=round((price - avg) / avg * 100, 2),
        )
        for ticker, name, shares, avg, price in _DEMO_HOLDINGS
    ]
    value = round(sum(p.market_value or 0 for p in positions), 2)
    cost = round(sum(p.cost_basis for p in positions), 2)
    return PortfolioSnapshot(
        positions=positions,
        totals=PortfolioTotals(
            market_value=value,
            cost_basis=cost,
            gain_loss=round(value - cost, 2),
            gain_loss_percent=round((value - cost) / cost * 100, 2),
        ),
        as_of=datetime(2026, 10, 1, 20, 0, tzinfo=UTC),
    )


class ToolCollector(BaseCallbackHandler):
    """Captures each tool call's name, arguments and output (for judging)."""

    run_inline = True

    def __init__(self) -> None:
        self.calls: list[ToolCallRecord] = []
        self._open: dict[UUID, ToolCallRecord] = {}

    def on_tool_start(
        self,
        serialized: dict[str, Any] | None,
        input_str: str,
        *,
        run_id: UUID,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        name = (serialized or {}).get("name") or kwargs.get("name") or "tool"
        args = inputs if isinstance(inputs, dict) else _parse_args(input_str)
        record = ToolCallRecord(name=str(name), args=args)
        self._open[run_id] = record
        self.calls.append(record)

    def on_tool_end(self, output: Any, *, run_id: UUID, **_: Any) -> None:
        record = self._open.pop(run_id, None)
        if record is not None:
            record.output = _output_text(output)[:_MAX_TOOL_OUTPUT_CHARS]

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **_: Any) -> None:
        record = self._open.pop(run_id, None)
        if record is not None:
            record.output = f"error: {error}"


def _parse_args(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return {"input": text}
    return value if isinstance(value, dict) else {"input": value}


def _output_text(output: Any) -> str:
    content = output.content if isinstance(output, ToolMessage) else output
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content)


class EvalTracer:
    """Adds a ToolCollector to each turn, on top of the real (or no-op) tracer."""

    def __init__(self, inner: Tracer | None = None) -> None:
        self.inner: Tracer = inner or NoopTracer()
        self.enabled = self.inner.enabled
        self.collector = ToolCollector()

    def reset(self) -> None:
        """Start a fresh collector (guardrail refusals never start a turn)."""
        self.collector = ToolCollector()

    def start_turn(self, **kwargs: Any) -> TurnTrace:
        self.reset()
        trace = self.inner.start_turn(**kwargs)
        config = dict(trace.config)
        config["callbacks"] = [*config.get("callbacks", []), self.collector]
        return TurnTrace(config=config, handler=trace.handler)

    def record_event(self, **kwargs: Any) -> str | None:
        return self.inner.record_event(**kwargs)

    def score(self, **kwargs: Any) -> None:
        self.inner.score(**kwargs)

    def flush(self) -> None:
        self.inner.flush()

    def shutdown(self, timeout: float = 3.0) -> None:
        self.inner.shutdown(timeout)


async def run_case(
    service: ChatService,
    tracer: EvalTracer,
    case: EvalCase,
    *,
    model: str,
    portfolio: PortfolioSnapshot,
    today: date | None = None,
    trace_tags: Sequence[str] = (),
) -> TurnRecord:
    """One case through the agent, exactly as a chat turn runs."""
    request = ChatTurnRequest(
        user_id=EVAL_USER_ID,
        conversation_id=f"eval-{case.id}",
        message=case.question,
        portfolio=portfolio,
        today=today,
        time_zone="America/New_York",
    )
    record = TurnRecord(case_id=case.id, model=model)
    tracer.reset()
    started = time.perf_counter()
    async for event in service.stream_turn(request, trace_tags=trace_tags):
        if event.type == "done":
            data = event.data
            usage = data.get("usage") or {}
            record = record.model_copy(
                update={
                    "content": data["content"],
                    "status": data["status"],
                    "citations": data.get("citations", []),
                    "charts": data.get("charts", []),
                    "input_tokens": int(usage.get("input_tokens", 0)),
                    "output_tokens": int(usage.get("output_tokens", 0)),
                    "trace_id": data.get("trace_id"),
                }
            )
        elif event.type == "error":
            record = record.model_copy(
                update={"error": f"{event.data['code']}: {event.data['message']}"}
            )
    record.latency_s = round(time.perf_counter() - started, 2)
    record.tool_calls = list(tracer.collector.calls)
    return record
