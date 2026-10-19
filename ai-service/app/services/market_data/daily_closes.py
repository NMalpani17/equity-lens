"""Daily closes for portfolio performance, cached in Postgres.

Closes are split-adjusted but not dividend-adjusted (price return), from
yfinance (Finnhub's candles are not on the free plan). Only completed sessions
are stored, and each request fetches just what the cache is missing: the range
before what it covers, or the sessions since it was last filled.

A split rewrites every earlier close, so when a refill sees one (or sees
already-stored closes change), the ticker's cached history is replaced.
"""

import logging
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import psycopg
import yfinance as yf

from app.config import get_settings
from app.models.daily_closes import DailyClosesResponse
from app.models.price_history import PricePoint

from .base import ProviderUnavailableError
from .repository import (
    STATUS_NO_HISTORY,
    Coverage,
    MarketDataRepository,
    shared_repository,
)

logger = logging.getLogger(__name__)

MARKET_TZ = ZoneInfo("America/New_York")
# A session's close counts as final from this New York time (4pm close plus
# margin for Yahoo's final print).
SESSION_FINAL_AT = time(16, 30)
EARLIEST_START = date(1990, 1, 1)
# A refill re-reads this many days already cached, to spot changed closes.
OVERLAP_DAYS = 10
# Stored and fresh closes further apart than this mean the history was
# re-adjusted (a split).
ADJUSTMENT_TOLERANCE = 0.005
NO_HISTORY_RETRY = timedelta(days=1)

Rows = list[tuple[date, float]]


@dataclass(frozen=True)
class FetchedHistory:
    rows: Rows
    split_dates: list[date] = field(default_factory=list)


# (symbol, start) -> closes from start to now. Raises ProviderUnavailableError.
HistoryFetcher = Callable[[str, date], FetchedHistory]
RepositoryProvider = Callable[[], MarketDataRepository | None]


def yahoo_symbol(symbol: str) -> str:
    """Yahoo writes share classes with a dash (BRK.B is BRK-B)."""
    return symbol.replace(".", "-")


def fetch_yfinance_daily(symbol: str, start: date) -> FetchedHistory:
    """Split-adjusted daily closes (not dividend-adjusted) and split dates."""
    try:
        frame = yf.Ticker(yahoo_symbol(symbol)).history(
            start=start.isoformat(), interval="1d", auto_adjust=False, actions=True
        )
    except Exception as exc:  # yfinance raises assorted network/parse errors
        raise ProviderUnavailableError(f"yfinance history failed: {exc}") from exc
    if frame.empty:
        return FetchedHistory([])
    rows = [
        (index.date(), float(close))
        for index, close in frame["Close"].items()
        if close == close  # skip NaN
    ]
    splits = (
        [index.date() for index, ratio in frame["Stock Splits"].items() if ratio]
        if "Stock Splits" in frame.columns
        else []
    )
    return FetchedHistory(rows, splits)


def last_completed_session(now: datetime) -> date:
    """The latest calendar day whose session is over, in New York.

    A weekend or holiday simply has no close; it is still "completed".
    """
    local = now.astimezone(MARKET_TZ)
    if local.time() >= SESSION_FINAL_AT:
        return local.date()
    return local.date() - timedelta(days=1)


@dataclass(frozen=True)
class _Outcome:
    """A per-ticker result: rows to serve, None to read the cache, or an error."""

    rows: Rows | None = None
    error: str | None = None


class DailyClosesService:
    def __init__(
        self,
        fetcher: HistoryFetcher,
        repository: RepositoryProvider,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        max_workers: int = 8,
    ) -> None:
        self._fetcher = fetcher
        self._repository = repository
        self._clock = clock
        self._max_workers = max_workers

    def get_closes(self, symbols: Sequence[str], start: date) -> DailyClosesResponse:
        now = self._clock()
        through = last_completed_session(now)
        start = max(min(start, through), EARLIEST_START)
        repo = self._repository()
        coverage: dict[str, Coverage] = {}
        if repo is not None:
            try:
                coverage = repo.coverage(symbols)
            except psycopg.Error as exc:
                logger.warning("market data cache read failed: %s", exc)
                repo = None

        def resolve(symbol: str) -> _Outcome:
            if repo is not None:
                try:
                    return self._resolve_cached(
                        repo, symbol, coverage.get(symbol), start, through, now
                    )
                except psycopg.Error as exc:
                    logger.warning("market data cache failed for %s: %s", symbol, exc)
            return self._fetch_uncached(symbol, start, through)

        workers = max(1, min(self._max_workers, len(symbols)))
        with ThreadPoolExecutor(workers, thread_name_prefix="daily-closes") as pool:
            outcomes = dict(zip(symbols, pool.map(resolve, symbols), strict=True))

        response = DailyClosesResponse(through=through)
        from_cache = [s for s, o in outcomes.items() if o.rows is None and not o.error]
        cached: dict[str, Rows] = {}
        if from_cache and repo is not None:
            try:
                cached = repo.closes(from_cache, start)
            except psycopg.Error as exc:
                logger.warning("market data cache read failed: %s", exc)
                outcomes.update({s: _Outcome(error="unavailable") for s in from_cache})
        for symbol, outcome in outcomes.items():
            rows = outcome.rows if outcome.rows is not None else cached.get(symbol)
            if outcome.error or not rows:
                response.errors[symbol] = outcome.error or "not_found"
                continue
            response.series[symbol] = [
                PricePoint(date=d, close=round(c, 6)) for d, c in rows if d >= start
            ]
        logger.info(
            "daily closes for %d tickers from %s (%d errors)",
            len(symbols),
            start,
            len(response.errors),
        )
        return response

    def _fetch_uncached(self, symbol: str, start: date, through: date) -> _Outcome:
        try:
            fetched = self._fetcher(symbol, start)
        except ProviderUnavailableError as exc:
            logger.warning("daily closes unavailable for %s: %s", symbol, exc)
            return _Outcome(error="unavailable")
        rows = _completed(fetched.rows, start, through)
        return _Outcome(rows=rows) if rows else _Outcome(error="not_found")

    def _resolve_cached(
        self,
        repo: MarketDataRepository,
        symbol: str,
        cov: Coverage | None,
        start: date,
        through: date,
        now: datetime,
    ) -> _Outcome:
        try:
            if cov is None or cov.covered_from > start:
                return self._fill(repo, symbol, start, through)
            if cov.status == STATUS_NO_HISTORY:
                fetched_at = cov.fetched_at.replace(tzinfo=UTC)
                if now - fetched_at < NO_HISTORY_RETRY:
                    return _Outcome(error="not_found")
                return self._fill(repo, symbol, start, through)
            if cov.fetched_through < through:
                return self._refresh_tail(repo, symbol, cov, through)
            return _Outcome()
        except ProviderUnavailableError as exc:
            logger.warning("daily closes unavailable for %s: %s", symbol, exc)
            # Stale closes beat none.
            if cov is not None and cov.status != STATUS_NO_HISTORY:
                return _Outcome()
            return _Outcome(error="unavailable")

    def _fill(
        self, repo: MarketDataRepository, symbol: str, start: date, through: date
    ) -> _Outcome:
        """Fetch everything from ``start`` and replace the ticker's cache."""
        rows = _completed(self._fetcher(symbol, start).rows, start, through)
        try:
            if rows:
                repo.save_closes(
                    symbol,
                    rows,
                    covered_from=start,
                    fetched_through=through,
                    replace=True,
                )
            else:
                repo.mark_no_history(
                    symbol, covered_from=start, fetched_through=through
                )
        except psycopg.Error as exc:
            logger.warning("market data cache write failed for %s: %s", symbol, exc)
        return _Outcome(rows=rows) if rows else _Outcome(error="not_found")

    def _refresh_tail(
        self,
        repo: MarketDataRepository,
        symbol: str,
        cov: Coverage,
        through: date,
    ) -> _Outcome:
        """Fetch the sessions since the last fill (plus a small overlap)."""
        overlap_start = cov.fetched_through - timedelta(days=OVERLAP_DAYS)
        fetched = self._fetcher(symbol, overlap_start)
        rows = _completed(fetched.rows, overlap_start, through)
        stored = repo.closes([symbol], overlap_start).get(symbol, [])
        new_split = any(d > cov.fetched_through for d in fetched.split_dates)
        if new_split or _readjusted(stored, rows):
            logger.info("history of %s was re-adjusted; refetching it", symbol)
            return self._fill(repo, symbol, cov.covered_from, through)
        try:
            repo.save_closes(
                symbol,
                rows,
                covered_from=cov.covered_from,
                fetched_through=through,
                replace=False,
            )
        except psycopg.Error as exc:
            logger.warning("market data cache write failed for %s: %s", symbol, exc)
        return _Outcome()


def _completed(rows: Rows, start: date, through: date) -> Rows:
    return [(d, c) for d, c in rows if start <= d <= through]


def _readjusted(stored: Rows, fresh: Rows) -> bool:
    """True when a close already stored differs from the fresh one."""
    fresh_by_date = dict(fresh)
    for day, close in stored:
        new = fresh_by_date.get(day)
        if new is not None and close and abs(new / close - 1) > ADJUSTMENT_TOLERANCE:
            return True
    return False


@lru_cache
def get_daily_closes_service() -> DailyClosesService:
    return DailyClosesService(
        fetch_yfinance_daily,
        shared_repository,
        max_workers=get_settings().market_history_workers,
    )
