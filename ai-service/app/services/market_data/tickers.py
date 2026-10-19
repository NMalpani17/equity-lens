"""Batch "is this a real ticker?" check for holdings imports.

A 500-row CSV must never spend Finnhub's 60-calls-a-minute plan, so tickers
are settled, cheapest first, by: this checker's own memo, the live quote cache,
the company profile and price history caches (a ticker we hold data for is
real), then one batched yfinance download of the rest. Finnhub is used only
when yfinance is down, for at most ``finnhub_budget`` tickers per request;
anything left over is "unavailable" (the import lets those through, like
adding a single holding does).
"""

import logging
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import Literal

import psycopg
import yfinance as yf

from app.config import get_settings
from app.services.rag.cache import TTLCache

from .base import ProviderUnavailableError
from .daily_closes import REACHABILITY_CANARY, yahoo_symbol
from .repository import STATUS_OK, MarketDataRepository, shared_repository
from .service import get_finnhub_provider, get_market_data_service

logger = logging.getLogger(__name__)

TickerStatus = Literal["ok", "not_found", "unavailable"]

# symbols -> {symbol: has recent prices}. Raises ProviderUnavailableError.
BatchChecker = Callable[[list[str]], dict[str, bool]]


def yfinance_batch_check(symbols: list[str]) -> dict[str, bool]:
    """Whether each symbol traded in the last few days, in one download.

    yfinance reports a network failure as "no prices", the same as an unknown
    ticker, so SPY rides along: without SPY prices nothing is called unknown.
    """
    by_yahoo = {yahoo_symbol(s): s for s in symbols}
    try:
        frame = yf.download(
            list(dict.fromkeys([*by_yahoo, REACHABILITY_CANARY])),
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

    def has_prices(yahoo: str) -> bool:
        return yahoo in closes.columns and bool(closes[yahoo].notna().any())

    if not has_prices(REACHABILITY_CANARY):
        raise ProviderUnavailableError("yfinance returned no prices for SPY")
    return {symbol: has_prices(yahoo) for yahoo, symbol in by_yahoo.items()}


class TickerVerifier:
    def __init__(
        self,
        *,
        cached_quote: Callable[[str], object | None],
        repository: Callable[[], MarketDataRepository | None],
        batch_check: BatchChecker,
        finnhub_has_quote: Callable[[str], bool],
        finnhub_budget: int,
        memo: TTLCache[TickerStatus],
    ) -> None:
        self._cached_quote = cached_quote
        self._repository = repository
        self._batch_check = batch_check
        self._finnhub_has_quote = finnhub_has_quote
        self._finnhub_budget = finnhub_budget
        self._memo = memo

    def verify(self, symbols: Sequence[str]) -> dict[str, TickerStatus]:
        results: dict[str, TickerStatus] = {}
        remaining: list[str] = []
        for symbol in dict.fromkeys(s.strip().upper() for s in symbols if s.strip()):
            known = self._memo.get(symbol)
            if known is not None:
                results[symbol] = known
            elif self._cached_quote(symbol) is not None:
                results[symbol] = "ok"
            else:
                remaining.append(symbol)

        for symbol in self._known_from_cache(remaining):
            results[symbol] = "ok"
        remaining = [s for s in remaining if s not in results]

        if remaining:
            try:
                checked = self._batch_check(remaining)
                for symbol in remaining:
                    results[symbol] = "ok" if checked.get(symbol) else "not_found"
            except ProviderUnavailableError as exc:
                logger.warning("batch ticker check unavailable: %s", exc)
                results.update(self._check_with_finnhub(remaining))

        for symbol, status in results.items():
            if status != "unavailable":
                self._memo.set(symbol, status)
        logger.info(
            "verified %d tickers (%d not found, %d unverified)",
            len(results),
            sum(s == "not_found" for s in results.values()),
            sum(s == "unavailable" for s in results.values()),
        )
        return results

    def _known_from_cache(self, symbols: list[str]) -> set[str]:
        repo = self._repository() if symbols else None
        if repo is None:
            return set()
        try:
            profiles = repo.profiles(symbols)
            coverage = repo.coverage(symbols)
        except psycopg.Error as exc:
            logger.warning("market data cache read failed: %s", exc)
            return set()
        return {s for s, p in profiles.items() if p.source != "none"} | {
            s for s, c in coverage.items() if c.status == STATUS_OK
        }

    def _check_with_finnhub(self, symbols: list[str]) -> dict[str, TickerStatus]:
        results: dict[str, TickerStatus] = {}
        for index, symbol in enumerate(symbols):
            if index >= self._finnhub_budget:
                results[symbol] = "unavailable"
                continue
            try:
                found = self._finnhub_has_quote(symbol)
                results[symbol] = "ok" if found else "not_found"
            except ProviderUnavailableError:
                results[symbol] = "unavailable"
        return results


@lru_cache
def get_ticker_verifier() -> TickerVerifier:
    settings = get_settings()
    return TickerVerifier(
        cached_quote=get_market_data_service().cached_quote,
        repository=shared_repository,
        batch_check=yfinance_batch_check,
        finnhub_has_quote=get_finnhub_provider().has_quote,
        finnhub_budget=settings.ticker_check_finnhub_budget,
        # Long enough that an import's save re-checks for free after its
        # preview.
        memo=TTLCache(max_size=5000, ttl_seconds=3600),
    )
