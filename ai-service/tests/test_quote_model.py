"""Tests for the Quote model's derived fields."""

from datetime import UTC, datetime

from app.models.quote import Quote


def test_build_derives_change_and_percent() -> None:
    quote = Quote.build(
        ticker="aapl",
        price=110.0,
        previous_close=100.0,
        provider="finnhub",
        as_of=datetime.now(UTC),
    )

    assert quote.ticker == "AAPL"  # normalized to upper
    assert quote.change == 10.0
    assert quote.change_percent == 10.0


def test_build_handles_zero_previous_close() -> None:
    quote = Quote.build(
        ticker="NEW",
        price=5.0,
        previous_close=0.0,
        provider="finnhub",
        as_of=datetime.now(UTC),
    )

    assert quote.change == 5.0
    assert quote.change_percent == 0.0  # no division by zero
