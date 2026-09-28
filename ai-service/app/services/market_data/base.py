"""Provider interface and error types for market data (adapter pattern).

Each concrete provider (Finnhub, yfinance, ...) implements
:class:`MarketDataProvider`. The service layer treats them uniformly and falls
back from one to the next.
"""

from abc import ABC, abstractmethod

from app.models.quote import Quote


class MarketDataError(Exception):
    """Base class for market-data failures."""


class QuoteNotFoundError(MarketDataError):
    """The ticker is invalid / unknown to the provider."""


class ProviderUnavailableError(MarketDataError):
    """The provider failed transiently (network, rate limit, bad response).

    Signals the service to try the next provider in the chain.
    """


class MarketDataProvider(ABC):
    """A source of market quotes."""

    #: Short, stable name used in logs and the ``provider`` field of a Quote.
    name: str

    @abstractmethod
    def get_quote(self, ticker: str) -> Quote:
        """Return a quote for ``ticker``.

        Raises:
            QuoteNotFoundError: if the ticker is unknown/invalid.
            ProviderUnavailableError: on transient failure (retry elsewhere).
        """
        raise NotImplementedError
