"""Tests for MarketDataService caching and provider fallback."""

from datetime import UTC, datetime

import pytest

from app.models.quote import Quote
from app.services.market_data.base import (
    MarketDataProvider,
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from app.services.market_data.cache import QuoteCache
from app.services.market_data.service import MarketDataService


class FakeProvider(MarketDataProvider):
    """Configurable provider for exercising the service's fallback logic."""

    def __init__(
        self,
        name: str,
        *,
        quote: Quote | None = None,
        error: Exception | None = None,
    ) -> None:
        self.name = name
        self._quote = quote
        self._error = error
        self.calls = 0

    def get_quote(self, ticker: str) -> Quote:
        self.calls += 1
        if self._error is not None:
            raise self._error
        assert self._quote is not None
        return self._quote


def make_quote(provider: str, ticker: str = "AAPL") -> Quote:
    return Quote.build(
        ticker=ticker,
        price=110.0,
        previous_close=100.0,
        provider=provider,
        as_of=datetime.now(UTC),
    )


def make_cache() -> QuoteCache:
    return QuoteCache(ttl_seconds=60)


def test_serves_from_primary_and_caches() -> None:
    primary = FakeProvider("finnhub", quote=make_quote("finnhub"))
    fallback = FakeProvider("yfinance", quote=make_quote("yfinance"))
    service = MarketDataService([primary, fallback], make_cache())

    first = service.get_quote("AAPL")
    second = service.get_quote("aapl")  # case-insensitive cache hit

    assert first.provider == "finnhub"
    assert second.provider == "finnhub"
    assert primary.calls == 1  # second call served from cache
    assert fallback.calls == 0


def test_falls_back_when_primary_unavailable() -> None:
    primary = FakeProvider("finnhub", error=ProviderUnavailableError("rate limit"))
    fallback = FakeProvider("yfinance", quote=make_quote("yfinance"))
    service = MarketDataService([primary, fallback], make_cache())

    quote = service.get_quote("AAPL")

    assert quote.provider == "yfinance"
    assert primary.calls == 1
    assert fallback.calls == 1


def test_unknown_ticker_raises_not_found() -> None:
    primary = FakeProvider("finnhub", error=QuoteNotFoundError("nope"))
    fallback = FakeProvider("yfinance", error=QuoteNotFoundError("nope"))
    service = MarketDataService([primary, fallback], make_cache())

    with pytest.raises(QuoteNotFoundError):
        service.get_quote("BADTICKER")


def test_all_unavailable_raises_unavailable() -> None:
    primary = FakeProvider("finnhub", error=ProviderUnavailableError("down"))
    fallback = FakeProvider("yfinance", error=ProviderUnavailableError("down"))
    service = MarketDataService([primary, fallback], make_cache())

    with pytest.raises(ProviderUnavailableError):
        service.get_quote("AAPL")


def test_get_quotes_isolates_failures() -> None:
    good = make_quote("finnhub", ticker="AAPL")

    class Mixed(MarketDataProvider):
        name = "mixed"

        def get_quote(self, ticker: str) -> Quote:
            if ticker == "AAPL":
                return good
            raise QuoteNotFoundError(ticker)

    service = MarketDataService([Mixed()], make_cache())

    response = service.get_quotes(["AAPL", "NOPE"])

    assert "AAPL" in response.quotes
    assert response.errors["NOPE"] == "not_found"
