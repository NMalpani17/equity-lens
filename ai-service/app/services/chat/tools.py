"""Read-only tool logic for the analyst agent.

These functions hold the behavior; ``mcp_server`` registers them as MCP tools.
Expected conditions (unknown ticker, indexing in progress, empty portfolio)
come back as a ``status`` plus a plain-language ``message`` so the model can
report them honestly; nothing here ever invents data.
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from app.localtime import format_local
from app.models.price_history import HistoryPeriod
from app.services.market_data.base import ProviderUnavailableError, QuoteNotFoundError
from app.services.market_data.history import PriceHistoryService
from app.services.market_data.service import MarketDataService

from .calculator import PositionMathError, calculate_position
from .context import TurnContext
from .transcripts import SearchDeps, search_transcripts

__all__ = ["ToolDeps", "ToolOutput", "search_transcripts"]

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolOutput:
    """What a tool returns: model-visible text plus structured data."""

    text: str
    data: dict[str, Any]

    @classmethod
    def of(cls, data: dict[str, Any]) -> "ToolOutput":
        return cls(text=json.dumps(data, default=str), data=data)


@dataclass(kw_only=True)
class ToolDeps(SearchDeps):
    """Dependencies for all tools (transcript search ones come from SearchDeps)."""

    market: Callable[[], MarketDataService]
    history: Callable[[], PriceHistoryService]


def get_quote(
    deps: ToolDeps, *, ticker: str, time_zone: str | None = None
) -> ToolOutput:
    symbol = ticker.strip().upper()
    try:
        quote = deps.market().get_quote(symbol)
    except QuoteNotFoundError:
        return ToolOutput.of(
            {
                "status": "not_found",
                "ticker": symbol,
                "message": f"Unknown ticker {symbol}.",
            }
        )
    except ProviderUnavailableError:
        return ToolOutput.of(
            {
                "status": "error",
                "ticker": symbol,
                "message": "Market data is temporarily unavailable.",
            }
        )
    return ToolOutput.of(
        {
            "status": "ok",
            "ticker": quote.ticker,
            "name": quote.name,
            "price": round(quote.price, 4),
            "previous_close": round(quote.previous_close, 4),
            "change": round(quote.change, 4),
            "change_percent": round(quote.change_percent, 2),
            "currency": quote.currency,
            "as_of": format_local(quote.as_of, time_zone),
        }
    )


def get_price_history(
    deps: ToolDeps, *, ticker: str, period: HistoryPeriod = "6mo"
) -> ToolOutput:
    symbol = ticker.strip().upper()
    try:
        history = deps.history().get_history(symbol, period)
    except QuoteNotFoundError:
        return ToolOutput.of(
            {
                "status": "not_found",
                "ticker": symbol,
                "message": f"No price history found for {symbol}.",
            }
        )
    except ProviderUnavailableError:
        return ToolOutput.of(
            {
                "status": "error",
                "ticker": symbol,
                "message": "Price history is temporarily unavailable.",
            }
        )
    return ToolOutput.of({"status": "ok", **history.model_dump(mode="json")})


def get_portfolio(turn: TurnContext | None) -> ToolOutput:
    if turn is None or turn.portfolio is None:
        return ToolOutput.of(
            {
                "status": "unavailable",
                "message": "The user's portfolio could not be loaded for this turn.",
            }
        )
    snapshot = turn.portfolio
    if not snapshot.positions:
        return ToolOutput.of(
            {
                "status": "empty",
                "message": "The user has no holdings yet. They can add positions on "
                "the Dashboard; meanwhile you can still discuss any stock.",
            }
        )
    total = snapshot.totals.market_value
    positions = []
    for p in sorted(snapshot.positions, key=lambda p: -(p.market_value or 0)):
        weight = (
            round(p.market_value / total * 100, 2) if total and p.market_value else None
        )
        positions.append({**p.model_dump(exclude_none=True), "weight_percent": weight})
    return ToolOutput.of(
        {
            "status": "ok",
            "as_of": format_local(snapshot.as_of, turn.time_zone)
            if snapshot.as_of
            else None,
            "positions": positions,
            "totals": snapshot.totals.model_dump(),
            "position_count": len(positions),
        }
    )


def resolve_company(
    deps: ToolDeps,
    turn: TurnContext | None = None,
    *,
    query: str,
    period: str | None = None,
) -> ToolOutput:
    resolution = deps.resolver().resolve(query, period)
    if turn and resolution.ticker and resolution.company_name:
        turn.company_names[resolution.ticker] = resolution.company_name
    return ToolOutput.of(resolution.as_dict())


def calculate_position_tool(
    turn: TurnContext | None,
    *,
    action: Literal["buy", "sell"],
    shares: float,
    price: float,
    ticker: str | None = None,
    current_shares: float | None = None,
    current_avg_cost: float | None = None,
    market_price: float | None = None,
) -> ToolOutput:
    """Position math; fills in the user's current position for ``ticker`` if omitted."""
    held, avg, source = current_shares, current_avg_cost, "provided"
    if ticker and held is None and turn and turn.portfolio:
        position = next(
            (p for p in turn.portfolio.positions if p.ticker == ticker.strip().upper()),
            None,
        )
        if position:
            held, avg, source = (
                position.total_shares,
                position.avg_buy_price,
                "portfolio",
            )
            if market_price is None:
                market_price = position.current_price
    try:
        result = calculate_position(
            action=action,
            shares=shares,
            price=price,
            current_shares=held or 0.0,
            current_avg_cost=avg or 0.0,
            market_price=market_price,
        )
    except PositionMathError as exc:
        return ToolOutput.of({"status": "invalid", "message": str(exc)})
    return ToolOutput.of(
        {
            "status": "ok",
            "position_source": source,
            **result.model_dump(exclude_none=True),
        }
    )
