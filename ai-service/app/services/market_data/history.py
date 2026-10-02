"""Historical prices (yfinance) summarized for analysis.

Finnhub's candle endpoint is not on the free plan, so history comes from
yfinance. Results are cached briefly; daily closes don't change intraday
except for the latest bar.
"""

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from functools import lru_cache
from typing import Any

import yfinance as yf

from app.config import get_settings
from app.models.price_history import HistoryPeriod, PriceHistory, PricePoint
from app.services.rag.cache import TTLCache

from .base import ProviderUnavailableError, QuoteNotFoundError

logger = logging.getLogger(__name__)

MAX_POINTS = 60
_WEEKLY_PERIODS = {"2y", "5y"}

# (symbol, period, interval) -> list of (date, close) and currency.
HistoryFetcher = Callable[[str, str, str], tuple[list[tuple[date, float]], str]]


def fetch_yfinance_history(
    symbol: str, period: str, interval: str
) -> tuple[list[tuple[date, float]], str]:
    """Daily/weekly adjusted closes from Yahoo Finance."""
    try:
        ticker = yf.Ticker(symbol)
        frame = ticker.history(period=period, interval=interval, auto_adjust=True)
        currency = (
            (getattr(ticker.fast_info, "currency", None) or "USD")
            if not frame.empty
            else ""
        )
    except Exception as exc:  # yfinance raises assorted network/parse errors
        raise ProviderUnavailableError(f"yfinance history failed: {exc}") from exc
    rows = (
        [
            (index.date(), float(close))
            for index, close in frame["Close"].items()
            if close == close  # skip NaN
        ]
        if not frame.empty
        else []
    )
    return rows, str(currency or "USD")


def downsample(points: list[Any], limit: int = MAX_POINTS) -> list[Any]:
    """Evenly thin a series to ``limit`` points, keeping the first and last."""
    if len(points) <= limit:
        return points
    step = (len(points) - 1) / (limit - 1)
    return [points[round(i * step)] for i in range(limit)]


class PriceHistoryService:
    def __init__(self, fetcher: HistoryFetcher, cache: TTLCache[PriceHistory]) -> None:
        self._fetcher = fetcher
        self._cache = cache

    def get_history(self, ticker: str, period: HistoryPeriod) -> PriceHistory:
        symbol = ticker.strip().upper()
        interval = "1wk" if period in _WEEKLY_PERIODS else "1d"
        return self._cache.get_or_compute(
            (symbol, period), lambda: self._build(symbol, period, interval)
        )

    def _build(self, symbol: str, period: HistoryPeriod, interval: str) -> PriceHistory:
        rows, currency = self._fetcher(symbol, period, interval)
        if not rows:
            raise QuoteNotFoundError(f"no price history for {symbol}")
        first_close, last_close = rows[0][1], rows[-1][1]
        high = max(rows, key=lambda r: r[1])
        low = min(rows, key=lambda r: r[1])
        change = last_close - first_close
        logger.info("price history for %s %s: %d bars", symbol, period, len(rows))
        return PriceHistory(
            ticker=symbol,
            period=period,
            interval=interval,  # type: ignore[arg-type]
            currency=currency,
            start_date=rows[0][0],
            end_date=rows[-1][0],
            first_close=round(first_close, 4),
            last_close=round(last_close, 4),
            change=round(change, 4),
            change_percent=round(change / first_close * 100, 2) if first_close else 0.0,
            high=round(high[1], 4),
            high_date=high[0],
            low=round(low[1], 4),
            low_date=low[0],
            points=[PricePoint(date=d, close=round(c, 4)) for d, c in downsample(rows)],
            provider="yfinance",
            as_of=datetime.now(UTC),
        )


@lru_cache
def get_price_history_service() -> PriceHistoryService:
    settings = get_settings()
    return PriceHistoryService(
        fetch_yfinance_history,
        TTLCache(max_size=256, ttl_seconds=max(settings.market_cache_ttl_seconds, 300)),
    )
