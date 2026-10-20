"""The earnings calendar (``market_earnings``): the next 60 days, whole market.

Finnhub's ``/calendar/earnings`` returns at most 1,500 rows per call and keeps
the latest dates, so one call for 60 days would silently drop the soonest
reports. A refresh therefore asks for the whole range and halves any window
that comes back full, until each window fits (a single day at the cap is kept
and logged as partial). It runs in the background at most once a day, paced
well under the shared Finnhub budget, and replaces the stored calendar in one
transaction; if Finnhub is down the stored calendar keeps serving.

Requests read Postgres only, so the Watchlist page costs no Finnhub calls.
"""

import logging
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
from psycopg_pool import ConnectionPool

from app.config import get_settings
from app.models.earnings import EarningsEvent, UpcomingEarningsResponse
from app.services.rag.rate_limit import SlidingWindowLimiter
from app.services.rag.repository import utcnow

from .base import BudgetSpentError, ProviderUnavailableError
from .refresh import (
    EARNINGS_CALENDAR,
    BackgroundRefresher,
    FreshnessCheck,
    RefreshPolicy,
    RefreshStateRepository,
    get_background_refresher,
    hold_lease,
    is_refreshing,
    mark_refreshed,
    refresh_policy,
    shared_state_repository,
)
from .repository import shared_pool
from .service import get_finnhub_provider
from .symbols import TICKER_RE

logger = logging.getLogger(__name__)

CALENDAR_ROW_CAP = 1500
MARKET_TZ = ZoneInfo("America/New_York")
_HOURS = frozenset({"bmo", "dmh", "amc"})
# Same-day order: before the open, during the session, after the close, unknown.
_HOUR_ORDER = {"bmo": 0, "dmh": 1, "amc": 2, None: 3}

# (start, end) inclusive -> Finnhub rows. Raises ProviderUnavailableError.
CalendarFetcher = Callable[[date, date], list[dict]]


@dataclass(frozen=True)
class EarningsRow:
    ticker: str
    date: date
    hour: str | None
    eps_estimate: float | None
    revenue_estimate: float | None
    fiscal_year: int | None
    fiscal_quarter: int | None


@dataclass(frozen=True)
class CalendarFetch:
    rows: list[EarningsRow]
    calls: int
    # Days that alone hit the row cap, so some of their reports may be missing.
    partial_days: list[date]


def market_today(now_utc: datetime) -> date:
    """Today's date in New York (the market's calendar day)."""
    return now_utc.replace(tzinfo=UTC).astimezone(MARKET_TZ).date()


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_rows(payload: Iterable[Any]) -> list[EarningsRow]:
    """Valid calendar rows (known ticker shape and an ISO date)."""
    rows: list[EarningsRow] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("symbol") or "").strip().upper()
        try:
            day = date.fromisoformat(str(item.get("date")))
        except ValueError:
            continue
        if not TICKER_RE.match(ticker):
            continue
        quarter = _int(item.get("quarter"))
        hour = item.get("hour")
        rows.append(
            EarningsRow(
                ticker=ticker,
                date=day,
                hour=hour if hour in _HOURS else None,
                eps_estimate=_number(item.get("epsEstimate")),
                revenue_estimate=_number(item.get("revenueEstimate")),
                fiscal_year=_int(item.get("year")),
                fiscal_quarter=quarter if quarter in (1, 2, 3, 4) else None,
            )
        )
    return rows


def fetch_calendar(
    fetch: CalendarFetcher,
    start: date,
    end: date,
    *,
    max_calls: int,
    cap: int = CALENDAR_ROW_CAP,
) -> CalendarFetch:
    """The whole calendar for ``start``..``end``, halving any full window.

    Raises ProviderUnavailableError if Finnhub fails or ``max_calls`` would
    be passed (the stored calendar is kept then).
    """
    windows = [(start, end)]
    found: dict[tuple[str, date], EarningsRow] = {}
    calls = 0
    partial: list[date] = []
    while windows:
        lo, hi = windows.pop()
        if calls >= max_calls:
            raise ProviderUnavailableError(
                f"earnings calendar needs more than {max_calls} calls"
            )
        batch = fetch(lo, hi)
        calls += 1
        if len(batch) >= cap and lo < hi:
            mid = lo + timedelta(days=(hi - lo).days // 2)
            windows.append((mid + timedelta(days=1), hi))
            windows.append((lo, mid))
            continue
        if len(batch) >= cap:
            partial.append(lo)
        for row in parse_rows(batch):
            if lo <= row.date <= hi:
                found.setdefault((row.ticker, row.date), row)
    rows = sorted(found.values(), key=lambda r: (r.date, r.ticker))
    return CalendarFetch(rows=rows, calls=calls, partial_days=sorted(partial))


def paced(
    fetch: CalendarFetcher,
    limiter: SlidingWindowLimiter,
    *,
    sleep: Callable[[float], None] = time.sleep,
    wait_seconds: float = 5.0,
    max_waits: int = 24,
) -> CalendarFetcher:
    """``fetch`` limited to its own pace, waiting out a spent shared budget.

    Only for background refreshes: requests must never wait like this.
    """

    def call(start: date, end: date) -> list[dict]:
        limiter.acquire(1)
        for attempt in range(max_waits + 1):
            try:
                return fetch(start, end)
            except BudgetSpentError:
                if attempt == max_waits:
                    raise
                sleep(wait_seconds)
        raise AssertionError("unreachable")

    return call


class EarningsRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def replace_all(
        self,
        rows: Sequence[EarningsRow],
        *,
        start: date,
        end: date,
        refresh_id: str,
        now: datetime,
    ) -> bool:
        """Swap in the new calendar and finish the refresh, in one transaction.

        False (nothing written) if the lease was lost to another refresh.
        """
        with self._pool.connection() as conn, conn.transaction():
            if not hold_lease(conn, EARNINGS_CALENDAR, refresh_id):
                return False
            conn.execute("DELETE FROM market_earnings")
            if rows:
                conn.execute(
                    """
                    INSERT INTO market_earnings
                        (ticker, date, hour, fiscal_year, fiscal_quarter,
                         eps_estimate, revenue_estimate, fetched_at)
                    SELECT t.*, %s
                    FROM unnest(
                        %s::text[], %s::date[], %s::text[], %s::int[], %s::int[],
                        %s::numeric[], %s::numeric[]
                    ) AS t
                    """,
                    (
                        now,
                        [r.ticker for r in rows],
                        [r.date for r in rows],
                        [r.hour for r in rows],
                        [r.fiscal_year for r in rows],
                        [r.fiscal_quarter for r in rows],
                        [r.eps_estimate for r in rows],
                        [r.revenue_estimate for r in rows],
                    ),
                )
            mark_refreshed(
                conn,
                EARNINGS_CALENDAR,
                row_count=len(rows),
                now=now,
                covered_from=start,
                covered_to=end,
            )
        return True

    def next_per_ticker(
        self, tickers: Sequence[str], start: date, end: date
    ) -> list[EarningsRow]:
        """Each ticker's first report on or after ``start``, up to ``end``."""
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT DISTINCT ON (ticker)
                    ticker, date, hour, eps_estimate, revenue_estimate,
                    fiscal_year, fiscal_quarter
                FROM market_earnings
                WHERE ticker = ANY(%s) AND date BETWEEN %s AND %s
                ORDER BY ticker, date
                """,
                (list(tickers), start, end),
            ).fetchall()
        return [
            EarningsRow(
                **{
                    **row,
                    "eps_estimate": _decimal(row["eps_estimate"]),
                    "revenue_estimate": _decimal(row["revenue_estimate"]),
                }
            )
            for row in rows
        ]


def _decimal(value: Any) -> float | None:
    return None if value is None else float(value)


def to_event(row: EarningsRow) -> EarningsEvent:
    return EarningsEvent(
        ticker=row.ticker,
        date=row.date,
        hour=row.hour,
        eps_estimate=row.eps_estimate,
        revenue_estimate=row.revenue_estimate,
        fiscal_year=row.fiscal_year,
        fiscal_quarter=row.fiscal_quarter,
    )


class EarningsService:
    def __init__(
        self,
        *,
        fetch: CalendarFetcher,
        states: Callable[[], RefreshStateRepository | None],
        earnings: Callable[[], EarningsRepository | None],
        refresher: BackgroundRefresher,
        policy: RefreshPolicy,
        days: int,
        max_calls: int,
        clock: Callable[[], datetime] = utcnow,
        check_every: timedelta = timedelta(seconds=60),
    ) -> None:
        self._fetch = fetch
        self._states = states
        self._earnings = earnings
        self._policy = policy
        self._days = days
        self._max_calls = max_calls
        self._clock = clock
        self._freshness = FreshnessCheck(
            EARNINGS_CALENDAR,
            states=states,
            refresher=refresher,
            policy=policy,
            clock=clock,
            check_every=check_every,
        )

    def upcoming(self, symbols: Sequence[str], days: int) -> UpcomingEarningsResponse:
        """The next report per ticker within ``days`` from today (New York).

        Reads Postgres only and never fails: without the calendar the answer
        lists every ticker as unscheduled and is marked unavailable.
        """
        self._freshness.ensure_fresh(self.refresh)
        now = self._clock()
        tickers = list(dict.fromkeys(s.strip().upper() for s in symbols if s.strip()))
        start = market_today(now)
        end = start + timedelta(days=min(days, self._days))
        empty = UpcomingEarningsResponse(
            unscheduled=tickers, window_start=start, window_end=end, available=False
        )
        repo, states = self._earnings(), self._states()
        if repo is None or states is None:
            return empty
        try:
            rows = repo.next_per_ticker(tickers, start, end)
            state = states.get(EARNINGS_CALENDAR)
        except psycopg.Error as exc:
            logger.warning("earnings calendar read failed: %s", exc)
            return empty
        refreshing = state is None or is_refreshing(state, now, self._policy)
        refreshed_at = state.refreshed_at if state else None
        scheduled = {row.ticker for row in rows}
        rows.sort(key=lambda r: (r.date, _HOUR_ORDER.get(r.hour, 3), r.ticker))
        return UpcomingEarningsResponse(
            earnings=[to_event(row) for row in rows],
            unscheduled=[t for t in tickers if t not in scheduled],
            window_start=start,
            window_end=end,
            refreshed_at=refreshed_at.replace(tzinfo=UTC) if refreshed_at else None,
            refreshing=refreshing,
            available=refreshed_at is not None or refreshing,
        )

    def refresh(self) -> bool:
        """Reload the calendar if due and the lease is ours; True when replaced."""
        states, repo = self._states(), self._earnings()
        if states is None or repo is None:
            return False
        refresh_id = states.claim(EARNINGS_CALENDAR, self._policy, now=self._clock())
        if refresh_id is None:
            return False
        start = market_today(self._clock())
        end = start + timedelta(days=self._days)
        try:
            result = fetch_calendar(self._fetch, start, end, max_calls=self._max_calls)
            replaced = repo.replace_all(
                result.rows,
                start=start,
                end=end,
                refresh_id=refresh_id,
                now=self._clock(),
            )
        except Exception as exc:  # any failure must release the lease
            logger.warning("earnings calendar refresh failed, keeping it: %s", exc)
            states.fail(EARNINGS_CALENDAR, refresh_id, str(exc))
            return False
        if result.partial_days:
            logger.warning(
                "earnings calendar days at the %d-row cap (may be incomplete): %s",
                CALENDAR_ROW_CAP,
                ", ".join(d.isoformat() for d in result.partial_days),
            )
        if replaced:
            logger.info(
                "earnings calendar refreshed: %d reports, %s..%s, %d calls",
                len(result.rows),
                start,
                end,
                result.calls,
            )
        else:
            logger.warning("earnings calendar refresh lost its lease; nothing written")
        return replaced


def shared_earnings_repository() -> EarningsRepository | None:
    pool = shared_pool()
    return EarningsRepository(pool) if pool is not None else None


@lru_cache
def get_earnings_service() -> EarningsService:
    settings = get_settings()
    return EarningsService(
        fetch=paced(
            get_finnhub_provider().get_earnings_calendar,
            SlidingWindowLimiter(settings.earnings_refresh_calls_per_minute),
        ),
        states=shared_state_repository,
        earnings=shared_earnings_repository,
        refresher=get_background_refresher(),
        policy=refresh_policy(timedelta(hours=settings.earnings_refresh_hours)),
        days=settings.earnings_days,
        max_calls=settings.earnings_refresh_max_calls,
    )
