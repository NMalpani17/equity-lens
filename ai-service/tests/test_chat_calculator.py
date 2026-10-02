"""Tests for deterministic position math."""

import pytest

from app.services.chat.calculator import PositionMathError, calculate_position


def test_buy_updates_average_cost() -> None:
    result = calculate_position(
        action="buy", shares=10, price=180, current_shares=20, current_avg_cost=120
    )

    assert result.shares_after == 30
    assert result.avg_cost_after == 140.0  # (20*120 + 10*180) / 30
    assert result.cost_basis_after == 4200.0
    assert result.realized_gain is None


def test_sell_realizes_gain_and_keeps_average_cost() -> None:
    result = calculate_position(
        action="sell",
        shares=5,
        price=200,
        current_shares=20,
        current_avg_cost=150,
        market_price=210,
    )

    assert result.shares_after == 15
    assert result.avg_cost_after == 150.0
    assert result.realized_gain == 250.0 and result.realized_gain_percent == 33.33
    assert result.market_value_after == 3150.0
    assert result.unrealized_gain_after == 900.0


def test_hypothetical_new_position_with_market_price() -> None:
    result = calculate_position(action="buy", shares=3, price=100.1, market_price=90)

    assert result.avg_cost_after == 100.1
    assert result.unrealized_gain_after == -30.3
    assert result.unrealized_gain_percent_after == -10.09


def test_decimal_math_avoids_float_noise() -> None:
    result = calculate_position(
        action="buy", shares=0.1, price=0.2, current_shares=0.2, current_avg_cost=0.1
    )

    assert result.cost_basis_after == 0.04
    assert result.avg_cost_after == 0.1333


@pytest.mark.parametrize(
    "kwargs",
    [
        {
            "action": "sell",
            "shares": 30,
            "price": 10,
            "current_shares": 20,
            "current_avg_cost": 5,
        },
        {"action": "buy", "shares": 0, "price": 10},
        {"action": "buy", "shares": 1, "price": -1},
        {"action": "buy", "shares": 1, "price": 1, "current_shares": 5},
    ],
)
def test_invalid_trades_are_rejected(kwargs) -> None:
    with pytest.raises(PositionMathError):
        calculate_position(**kwargs)
