"""Tests for the yfinance quote provider (yfinance mocked)."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.services.market_data.base import ProviderUnavailableError, QuoteNotFoundError
from app.services.market_data.yfinance_provider import YFinanceProvider


def fake_ticker(**fast_info):
    return SimpleNamespace(fast_info=SimpleNamespace(**fast_info))


def test_reads_fast_info_attributes() -> None:
    with patch(
        "app.services.market_data.yfinance_provider.yf.Ticker",
        return_value=fake_ticker(
            last_price=110.0, previous_close=100.0, currency="USD"
        ),
    ):
        quote = YFinanceProvider().get_quote("msft")

    assert quote.ticker == "MSFT" and quote.price == 110.0
    assert quote.change_percent == pytest.approx(10.0)


def test_missing_prices_mean_unknown_ticker() -> None:
    with patch(
        "app.services.market_data.yfinance_provider.yf.Ticker",
        return_value=fake_ticker(last_price=None, previous_close=None),
    ):
        with pytest.raises(QuoteNotFoundError):
            YFinanceProvider().get_quote("ZZZZ")


def test_errors_mean_unavailable() -> None:
    with patch(
        "app.services.market_data.yfinance_provider.yf.Ticker",
        side_effect=RuntimeError("network"),
    ):
        with pytest.raises(ProviderUnavailableError):
            YFinanceProvider().get_quote("AAPL")
