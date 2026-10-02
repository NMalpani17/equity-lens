"""Inline charts built from tool results (generative UI).

Every number in a chart comes from a tool's structured output, never from
text the model wrote: ``get_price_history`` becomes a price line chart and
``get_portfolio`` an allocation chart. The agent streams each chart as soon
as its tool returns and attaches the turn's charts to the final message.
"""

import logging
from typing import Any

from pydantic import ValidationError

from app.models.chat import (
    AllocationChart,
    AllocationSlice,
    ChartPoint,
    ChatChart,
    PriceChart,
)

logger = logging.getLogger(__name__)

MAX_CHARTS_PER_TURN = 4
# Holdings beyond this many are grouped as "Other" so labels stay legible.
MAX_ALLOCATION_SLICES = 8
OTHER_TICKER = "Other"


def chart_key(chart: ChatChart) -> str:
    """Charts with the same key show the same thing; the newest one wins."""
    if isinstance(chart, PriceChart):
        return f"price:{chart.ticker}:{chart.period}"
    return "portfolio"


def build_chart(tool_name: str, data: Any, chart_id: str) -> ChatChart | None:
    """The chart for one successful tool result, or None if it has none."""
    if not isinstance(data, dict) or data.get("status") != "ok":
        return None
    try:
        match tool_name:
            case "get_price_history":
                return _price_chart(data, chart_id)
            case "get_portfolio":
                return _allocation_chart(data, chart_id)
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        logger.warning("skipping chart for %s: %s", tool_name, exc)
    return None


def _price_chart(data: dict[str, Any], chart_id: str) -> PriceChart | None:
    points = [ChartPoint.model_validate(p) for p in data.get("points") or []]
    if len(points) < 2:
        return None
    return PriceChart(
        id=chart_id,
        ticker=data["ticker"],
        period=data["period"],
        currency=data.get("currency") or "USD",
        points=points,
        first_close=data["first_close"],
        last_close=data["last_close"],
        change=data["change"],
        change_percent=data["change_percent"],
        high=data["high"],
        low=data["low"],
        as_of=data.get("as_of"),
    )


def _allocation_chart(data: dict[str, Any], chart_id: str) -> AllocationChart | None:
    positions = data.get("positions") or []
    priced = [p for p in positions if (p.get("market_value") or 0) > 0]
    total = sum(float(p["market_value"]) for p in priced)
    if not priced or total <= 0:
        return None
    priced.sort(key=lambda p: -float(p["market_value"]))
    slices = [_slice(p, total) for p in priced]
    if len(slices) > MAX_ALLOCATION_SLICES:
        head, tail = (
            slices[: MAX_ALLOCATION_SLICES - 1],
            slices[MAX_ALLOCATION_SLICES - 1 :],
        )
        other = sum(s.market_value for s in tail)
        slices = [
            *head,
            AllocationSlice(
                ticker=OTHER_TICKER,
                name=f"{len(tail)} other holdings",
                market_value=round(other, 2),
                weight_percent=round(other / total * 100, 2),
            ),
        ]
    return AllocationChart(
        id=chart_id,
        slices=slices,
        total_market_value=round(total, 2),
        partial=len(priced) < len(positions)
        or bool((data.get("totals") or {}).get("partial")),
        as_of=data.get("as_of"),
    )


def _slice(position: dict[str, Any], total: float) -> AllocationSlice:
    value = float(position["market_value"])
    return AllocationSlice(
        ticker=position["ticker"],
        name=position.get("name"),
        market_value=round(value, 2),
        weight_percent=round(value / total * 100, 2),
    )
