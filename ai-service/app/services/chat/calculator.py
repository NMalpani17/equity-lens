"""Deterministic position math, so numbers never come from the model."""

from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from pydantic import BaseModel, Field

_CENT = Decimal("0.01")
_PRICE = Decimal("0.0001")


class PositionMathError(ValueError):
    """Inputs that cannot describe a valid trade."""


class PositionMathResult(BaseModel):
    action: Literal["buy", "sell"]
    shares_traded: float
    trade_price: float
    shares_before: float
    avg_cost_before: float
    shares_after: float
    avg_cost_after: float = Field(description="Average cost per share after the trade.")
    cost_basis_after: float
    realized_gain: float | None = Field(
        default=None, description="Gain on the shares sold (sells only)."
    )
    realized_gain_percent: float | None = None
    market_price: float | None = None
    market_value_after: float | None = None
    unrealized_gain_after: float | None = None
    unrealized_gain_percent_after: float | None = None


def _d(value: float) -> Decimal:
    return Decimal(str(value))


def _money(value: Decimal) -> float:
    return float(value.quantize(_CENT, rounding=ROUND_HALF_UP))


def _price(value: Decimal) -> float:
    return float(value.quantize(_PRICE, rounding=ROUND_HALF_UP))


def _pct(part: Decimal, whole: Decimal) -> float | None:
    if whole == 0:
        return None
    return _money(part / whole * 100)


def calculate_position(
    *,
    action: Literal["buy", "sell"],
    shares: float,
    price: float,
    current_shares: float = 0.0,
    current_avg_cost: float = 0.0,
    market_price: float | None = None,
) -> PositionMathResult:
    """Apply a hypothetical buy or sell to a position (average-cost method)."""
    if shares <= 0 or price <= 0:
        raise PositionMathError("shares and price must be positive")
    if current_shares < 0 or current_avg_cost < 0:
        raise PositionMathError("current shares and average cost cannot be negative")
    if current_shares > 0 and current_avg_cost == 0:
        raise PositionMathError("an existing position needs its average cost")

    qty, px = _d(shares), _d(price)
    held, avg = _d(current_shares), _d(current_avg_cost)
    realized: Decimal | None = None

    if action == "buy":
        after = held + qty
        new_avg = (held * avg + qty * px) / after
    else:
        if qty > held:
            raise PositionMathError(
                f"cannot sell {shares} shares; only {current_shares} held"
            )
        after = held - qty
        new_avg = avg if after > 0 else Decimal(0)
        realized = (px - avg) * qty

    basis = after * new_avg
    result = PositionMathResult(
        action=action,
        shares_traded=shares,
        trade_price=price,
        shares_before=current_shares,
        avg_cost_before=current_avg_cost,
        shares_after=float(after),
        avg_cost_after=_price(new_avg),
        cost_basis_after=_money(basis),
        realized_gain=_money(realized) if realized is not None else None,
        realized_gain_percent=_pct(realized, avg * qty)
        if realized is not None
        else None,
    )
    if market_price is not None and market_price > 0:
        mkt = _d(market_price)
        value = after * mkt
        result.market_price = market_price
        result.market_value_after = _money(value)
        result.unrealized_gain_after = _money(value - basis)
        result.unrealized_gain_percent_after = _pct(value - basis, basis)
    return result
