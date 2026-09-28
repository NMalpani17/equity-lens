"""yfinance market-data provider (automatic fallback).

yfinance scrapes Yahoo Finance and has no API key or documented rate limit,
which makes it a good fallback when Finnhub fails or is throttled.
"""

import logging
from datetime import UTC, datetime

import yfinance as yf

from app.models.quote import Quote

from .base import (
    MarketDataProvider,
    ProviderUnavailableError,
    QuoteNotFoundError,
)

logger = logging.getLogger(__name__)


class YFinanceProvider(MarketDataProvider):
    """Fetches quotes from Yahoo Finance via the ``yfinance`` library."""

    name = "yfinance"

    def get_quote(self, ticker: str) -> Quote:
        symbol = ticker.upper()
        try:
            fast_info = yf.Ticker(symbol).fast_info
            price = fast_info.get("last_price")
            previous_close = fast_info.get("previous_close")
            currency = fast_info.get("currency") or "USD"
        except Exception as exc:  # yfinance raises assorted network/parse errors
            raise ProviderUnavailableError(f"yfinance request failed: {exc}") from exc

        if price is None or previous_close is None:
            raise QuoteNotFoundError(f"unknown ticker: {symbol}")

        return Quote.build(
            ticker=symbol,
            price=float(price),
            previous_close=float(previous_close),
            provider=self.name,
            as_of=datetime.now(UTC),
            currency=str(currency),
        )
