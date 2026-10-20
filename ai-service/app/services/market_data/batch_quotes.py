"""Quotes for many tickers at once (the watchlist), on a fixed Finnhub budget.

A 50-ticker watchlist must not spend a minute of Finnhub's shared budget.
Each ticker is served, cheapest first, from:
  1. the shared 60-second quote cache (also filled by the portfolio),
  2. Finnhub's /quote alone (no name lookup: names come from the symbol list),
     for at most ``finnhub_budget`` tickers per request,
  3. one batched yfinance download for the rest.
Anything still missing is "unavailable" ("not_found" only when Finnhub said
so and yfinance had nothing). Results go back into the shared cache.
"""

import logging
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from functools import lru_cache

import yfinance as yf

from app.config import get_settings
from app.models.quote import Quote, QuotesResponse

from .base import ProviderUnavailableError, QuoteNotFoundError
from .daily_closes import yahoo_symbol
from .service import MarketDataService, get_finnhub_provider, get_market_data_service

logger = logging.getLogger(__name__)

# symbols -> {symbol: quote} for those found. Raises ProviderUnavailableError.
BatchDownloader = Callable[[list[str]], dict[str, Quote]]


def yfinance_batch_quotes(symbols: list[str]) -> dict[str, Quote]:
    """Last price and previous close per symbol, from one daily download.

    During a session the last daily bar is today's, priced at the latest
    trade; the bar before it is the previous close.
    """
    by_yahoo = {yahoo_symbol(s): s for s in symbols}
    try:
        frame = yf.download(
            list(by_yahoo),
            period="5d",
            interval="1d",
            auto_adjust=False,
            progress=False,
            threads=True,
            multi_level_index=True,
        )
    except Exception as exc:  # yfinance raises assorted network/parse errors
        raise ProviderUnavailableError(f"yfinance download failed: {exc}") from exc
    if frame is None or frame.empty:
        raise ProviderUnavailableError("yfinance returned no prices")
    closes = frame["Close"]
    now = datetime.now(UTC)
    quotes: dict[str, Quote] = {}
    for yahoo, symbol in by_yahoo.items():
        if yahoo not in closes.columns:
            continue
        series = closes[yahoo].dropna()
        if len(series) < 2:
            continue
        quotes[symbol] = Quote.build(
            ticker=symbol,
            price=float(series.iloc[-1]),
            previous_close=float(series.iloc[-2]),
            provider="yfinance",
            as_of=now,
        )
    return quotes


class BatchQuoteService:
    def __init__(
        self,
        *,
        market: MarketDataService,
        finnhub_price: Callable[[str], Quote],
        batch_download: BatchDownloader,
        finnhub_budget: int,
    ) -> None:
        self._market = market
        self._finnhub_price = finnhub_price
        self._batch_download = batch_download
        self._finnhub_budget = finnhub_budget

    def get_quotes(self, symbols: Sequence[str]) -> QuotesResponse:
        response = QuotesResponse()
        missing: list[str] = []
        for symbol in dict.fromkeys(s.strip().upper() for s in symbols if s.strip()):
            cached = self._market.cached_quote(symbol)
            if cached is not None:
                response.quotes[symbol] = cached
            else:
                missing.append(symbol)

        finnhub_not_found: set[str] = set()
        rest: list[str] = []
        from_finnhub = 0
        for index, symbol in enumerate(missing):
            if index >= self._finnhub_budget:
                rest.append(symbol)
                continue
            try:
                response.quotes[symbol] = self._finnhub_price(symbol)
                from_finnhub += 1
            except QuoteNotFoundError:
                finnhub_not_found.add(symbol)
                rest.append(symbol)
            except ProviderUnavailableError:
                rest.append(symbol)

        if rest:
            try:
                response.quotes.update(self._batch_download(rest))
            except ProviderUnavailableError as exc:
                logger.warning("batch quote download unavailable: %s", exc)
        for symbol in rest:
            if symbol not in response.quotes:
                not_found = symbol in finnhub_not_found
                response.errors[symbol] = "not_found" if not_found else "unavailable"

        for symbol in missing:
            if symbol in response.quotes:
                self._market.remember(response.quotes[symbol])
        logger.info(
            "batch quotes: %d cached, %d from finnhub, %d downloaded, %d missing",
            len(response.quotes) + len(response.errors) - len(missing),
            from_finnhub,
            sum(1 for s in rest if s in response.quotes),
            len(response.errors),
        )
        return response


@lru_cache
def get_batch_quote_service() -> BatchQuoteService:
    return BatchQuoteService(
        market=get_market_data_service(),
        finnhub_price=get_finnhub_provider().get_price,
        batch_download=yfinance_batch_quotes,
        finnhub_budget=get_settings().batch_quote_finnhub_budget,
    )
