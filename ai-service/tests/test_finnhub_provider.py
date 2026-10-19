"""Tests for the Finnhub provider's response handling."""

import httpx
import pytest

from app.services.market_data.base import (
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from app.services.market_data.finnhub import FinnhubProvider
from app.services.rag.rate_limit import SlidingWindowLimiter


def patch_get(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    monkeypatch.setattr(httpx, "get", handler)


def test_returns_quote_with_name(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(url, params=None, headers=None, timeout=None):
        if "profile2" in url:
            return httpx.Response(200, json={"name": "Apple Inc"})
        return httpx.Response(200, json={"c": 150.0, "pc": 148.0})

    patch_get(monkeypatch, handler)
    provider = FinnhubProvider("key")

    quote = provider.get_quote("aapl")

    assert quote.ticker == "AAPL"
    assert quote.price == 150.0
    assert quote.previous_close == 148.0
    assert round(quote.change, 2) == 2.0
    assert quote.name == "Apple Inc"
    assert quote.provider == "finnhub"


def test_unknown_ticker_raises_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    # Finnhub returns c == 0 for unknown symbols.
    patch_get(monkeypatch, lambda *a, **k: httpx.Response(200, json={"c": 0, "pc": 0}))
    provider = FinnhubProvider("key")

    with pytest.raises(QuoteNotFoundError):
        provider.get_quote("NOPE")


def test_rate_limit_raises_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_get(monkeypatch, lambda *a, **k: httpx.Response(429, json={"error": "x"}))
    provider = FinnhubProvider("key")

    with pytest.raises(ProviderUnavailableError):
        provider.get_quote("AAPL")


def test_network_error_raises_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(*a, **k):
        raise httpx.ConnectError("boom")

    patch_get(monkeypatch, handler)
    provider = FinnhubProvider("key")

    with pytest.raises(ProviderUnavailableError):
        provider.get_quote("AAPL")


def test_a_spent_call_budget_fails_without_calling_finnhub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def handler(url, params=None, headers=None, timeout=None):
        calls.append(url)
        if "profile2" in url:
            return httpx.Response(200, json={"name": "Apple Inc"})
        return httpx.Response(200, json={"c": 150.0, "pc": 148.0})

    patch_get(monkeypatch, handler)
    provider = FinnhubProvider("key", limiter=SlidingWindowLimiter(3))

    # A quote costs two calls (/quote and the name from /stock/profile2).
    assert provider.get_quote("AAPL").name == "Apple Inc"
    # One call left: the quote goes through, its name lookup doesn't.
    assert provider.get_quote("MSFT").name is None
    with pytest.raises(ProviderUnavailableError):
        provider.get_quote("NVDA")
    assert len(calls) == 3


def test_missing_api_key_raises_unavailable() -> None:
    provider = FinnhubProvider("")

    with pytest.raises(ProviderUnavailableError):
        provider.get_quote("AAPL")
