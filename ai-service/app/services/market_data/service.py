"""Market-data service: caching + provider fallback + structured logging."""

import logging
from functools import lru_cache

from app.config import Settings, get_settings
from app.models.quote import Quote, QuotesResponse

from .base import (
    MarketDataProvider,
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from .cache import QuoteCache
from .finnhub import FinnhubProvider
from .yfinance_provider import YFinanceProvider

logger = logging.getLogger(__name__)


class MarketDataService:
    """Serves quotes from cache, then a prioritized chain of providers.

    Providers are tried in order. A :class:`ProviderUnavailableError` moves on
    to the next provider (the fallback). If every provider reports the ticker as
    unknown, a :class:`QuoteNotFoundError` is raised; if every provider is
    unavailable, a :class:`ProviderUnavailableError` is raised.
    """

    def __init__(self, providers: list[MarketDataProvider], cache: QuoteCache) -> None:
        if not providers:
            raise ValueError("at least one provider is required")
        self._providers = providers
        self._cache = cache

    def get_quote(self, ticker: str) -> Quote:
        symbol = ticker.upper()

        cached = self._cache.get(symbol)
        if cached is not None:
            logger.info(
                "quote served for %s by cache (origin=%s)", symbol, cached.provider
            )
            return cached

        saw_not_found = False
        for provider in self._providers:
            try:
                quote = provider.get_quote(symbol)
            except QuoteNotFoundError:
                saw_not_found = True
                logger.info("provider %s: ticker %s not found", provider.name, symbol)
                continue
            except ProviderUnavailableError as exc:
                logger.warning(
                    "provider %s unavailable for %s: %s", provider.name, symbol, exc
                )
                continue

            self._cache.set(symbol, quote)
            logger.info("quote served for %s by %s", symbol, provider.name)
            return quote

        if saw_not_found:
            raise QuoteNotFoundError(f"unknown ticker: {symbol}")
        raise ProviderUnavailableError(
            f"all market-data providers unavailable for {symbol}"
        )

    def get_quotes(self, tickers: list[str]) -> QuotesResponse:
        """Fetch many quotes, isolating per-ticker failures into ``errors``."""
        response = QuotesResponse()
        for ticker in tickers:
            symbol = ticker.upper()
            try:
                response.quotes[symbol] = self.get_quote(symbol)
            except QuoteNotFoundError:
                response.errors[symbol] = "not_found"
            except ProviderUnavailableError:
                response.errors[symbol] = "unavailable"
        return response


def _build_service(settings: Settings) -> MarketDataService:
    providers: list[MarketDataProvider] = [
        FinnhubProvider(
            settings.finnhub_api_key,
            base_url=settings.finnhub_base_url,
            timeout=settings.market_http_timeout_seconds,
        ),
        YFinanceProvider(),
    ]
    cache = QuoteCache(ttl_seconds=settings.market_cache_ttl_seconds)
    return MarketDataService(providers, cache)


@lru_cache
def get_market_data_service() -> MarketDataService:
    """Return a cached, application-wide market-data service."""
    return _build_service(get_settings())
