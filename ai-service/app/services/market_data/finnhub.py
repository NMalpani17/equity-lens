"""Finnhub market-data provider (primary)."""

import logging
from datetime import UTC, datetime

import httpx

from app.models.quote import Quote
from app.services.rag.rate_limit import SlidingWindowLimiter

from .base import (
    MarketDataProvider,
    ProviderUnavailableError,
    QuoteNotFoundError,
)

logger = logging.getLogger(__name__)


class FinnhubProvider(MarketDataProvider):
    """Fetches quotes from the Finnhub REST API.

    Every call takes one unit from ``limiter`` (the free plan allows 60 calls
    a minute). When the minute's budget is spent the call fails as
    unavailable without being sent, so callers fall back to yfinance.
    """

    name = "finnhub"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://finnhub.io/api/v1",
        timeout: float = 5.0,
        limiter: SlidingWindowLimiter | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._limiter = limiter

    def get_quote(self, ticker: str) -> Quote:
        if not self._api_key:
            # No key configured: treat as unavailable so we fall back.
            raise ProviderUnavailableError("finnhub api key not configured")

        symbol = ticker.upper()
        data = self._get_json("/quote", {"symbol": symbol})

        price = data.get("c")
        previous_close = data.get("pc")
        # Finnhub returns c == 0 (and pc == 0) for unknown symbols.
        if not price:
            raise QuoteNotFoundError(f"unknown ticker: {symbol}")

        return Quote.build(
            ticker=symbol,
            price=float(price),
            previous_close=float(previous_close or 0.0),
            provider=self.name,
            as_of=datetime.now(UTC),
            name=self._fetch_name(symbol),
        )

    def _get_json(self, path: str, params: dict[str, str]) -> dict:
        if self._limiter is not None and not self._limiter.try_acquire():
            raise ProviderUnavailableError("finnhub call budget for this minute spent")
        url = f"{self._base_url}{path}"
        try:
            response = httpx.get(
                url,
                params=params,
                # Header auth keeps the key out of URLs (and request logs).
                headers={"X-Finnhub-Token": self._api_key},
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailableError(f"finnhub request failed: {exc}") from exc

        if response.status_code == 429:
            raise ProviderUnavailableError("finnhub rate limit exceeded")
        if response.status_code >= 500:
            raise ProviderUnavailableError(
                f"finnhub server error: {response.status_code}"
            )
        if response.status_code >= 400:
            # 401/403 (bad key) etc. -> fall back rather than surfacing an error.
            raise ProviderUnavailableError(
                f"finnhub client error: {response.status_code}"
            )

        try:
            return response.json()
        except ValueError as exc:
            raise ProviderUnavailableError("finnhub returned invalid JSON") from exc

    def _fetch_name(self, symbol: str) -> str | None:
        """Best-effort company name lookup; never fails the quote."""
        try:
            data = self._get_json("/stock/profile2", {"symbol": symbol})
        except ProviderUnavailableError:
            return None
        name = data.get("name")
        return str(name) if name else None
