"""Earnings calendar: window splitting, parsing, pacing, the service and route."""

from collections.abc import Iterator
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.earnings import UpcomingEarningsResponse
from app.services.market_data.base import BudgetSpentError, ProviderUnavailableError
from app.services.market_data.earnings import (
    CALENDAR_ROW_CAP,
    EarningsRow,
    EarningsService,
    fetch_calendar,
    get_earnings_service,
    market_today,
    paced,
    parse_rows,
)
from app.services.market_data.refresh import (
    EARNINGS_CALENDAR,
    BackgroundRefresher,
    RefreshPolicy,
    RefreshState,
)
from app.services.rag.rate_limit import SlidingWindowLimiter
from tests.conftest import INTERNAL_HEADERS

# 2026-10-19 11:00 in New York.
NOW = datetime(2026, 10, 19, 15, 0)
TODAY = date(2026, 10, 19)
POLICY = RefreshPolicy(
    max_age=timedelta(hours=24),
    retry_after=timedelta(minutes=30),
    stale_after=timedelta(minutes=10),
)


def report(symbol: str, day: date, hour: str = "", eps=None) -> dict:
    return {
        "symbol": symbol,
        "date": day.isoformat(),
        "hour": hour,
        "quarter": 3,
        "year": 2026,
        "epsEstimate": eps,
        "epsActual": None,
        "revenueEstimate": None,
        "revenueActual": None,
    }


class CappedFinnhub:
    """Like Finnhub's free plan: at most ``cap`` rows, keeping the latest dates."""

    def __init__(self, rows: list[dict], cap: int = CALENDAR_ROW_CAP):
        self.rows = sorted(rows, key=lambda r: r["date"])
        self.cap = cap
        self.calls: list[tuple[date, date]] = []

    def __call__(self, start: date, end: date) -> list[dict]:
        self.calls.append((start, end))
        hits = [
            r for r in self.rows if start.isoformat() <= r["date"] <= end.isoformat()
        ]
        return hits[-self.cap :]


def split(finnhub: CappedFinnhub, max_calls: int = 40):
    """The next 60 days through ``fetch_calendar``, at the fake's row cap."""
    return fetch_calendar(
        finnhub,
        TODAY,
        TODAY + timedelta(days=60),
        max_calls=max_calls,
        cap=finnhub.cap,
    )


def busy_season(days: int = 61, per_day: int = 4) -> list[dict]:
    return [
        report(f"T{d}X{i}", TODAY + timedelta(days=d))
        for d in range(days)
        for i in range(per_day)
    ]


# --- Splitting ---------------------------------------------------------------


def test_one_call_when_the_window_fits() -> None:
    finnhub = CappedFinnhub([report("AMD", date(2026, 11, 3), "amc", 1.9664)])

    result = fetch_calendar(finnhub, TODAY, TODAY + timedelta(days=60), max_calls=40)

    assert finnhub.calls == [(TODAY, TODAY + timedelta(days=60))]
    assert [(r.ticker, r.date, r.hour, r.eps_estimate) for r in result.rows] == [
        ("AMD", date(2026, 11, 3), "amc", 1.9664)
    ]
    assert result.partial_days == []


def test_a_full_window_is_halved_until_nothing_is_dropped() -> None:
    rows = busy_season()  # 244 reports, cap 50
    finnhub = CappedFinnhub(rows, cap=50)

    result = split(finnhub)

    assert len(result.rows) == len(rows)
    assert {r.ticker for r in result.rows} == {r["symbol"] for r in rows}
    assert result.calls == len(finnhub.calls) <= 40
    assert result.partial_days == []

    # The answers that were kept (not full) tile the range: no gaps, no overlaps.
    def size(window: tuple[date, date]) -> int:
        lo, hi = (d.isoformat() for d in window)
        return sum(lo <= r["date"] <= hi for r in rows)

    kept = sorted(w for w in finnhub.calls if size(w) < 50)
    assert kept[0][0] == TODAY and kept[-1][1] == TODAY + timedelta(days=60)
    for (_, prev_end), (start, _) in zip(kept, kept[1:], strict=False):
        assert start == prev_end + timedelta(days=1)


def test_the_soonest_reports_survive_the_cap() -> None:
    # The probe: one 60-day call kept 11-10..12-18 and lost AMD on 11-03.
    rows = busy_season() + [report("AMD", date(2026, 11, 3), "amc")]
    one_call = CappedFinnhub(rows, cap=150)(TODAY, TODAY + timedelta(days=60))
    assert "AMD" not in {r["symbol"] for r in one_call}

    result = split(CappedFinnhub(rows, cap=150))

    assert ("AMD", date(2026, 11, 3)) in {(r.ticker, r.date) for r in result.rows}


def test_a_single_day_at_the_cap_is_kept_and_marked_partial() -> None:
    crowded = [report(f"C{i}", date(2026, 10, 29)) for i in range(60)]
    finnhub = CappedFinnhub([*crowded, report("AMD", date(2026, 11, 3))], cap=50)

    result = split(finnhub)

    assert result.partial_days == [date(2026, 10, 29)]
    assert sum(r.date == date(2026, 10, 29) for r in result.rows) == 50
    assert "AMD" in {r.ticker for r in result.rows}


def test_the_call_cap_fails_the_refresh() -> None:
    finnhub = CappedFinnhub(busy_season(), cap=10)

    with pytest.raises(ProviderUnavailableError, match="more than 5 calls"):
        split(finnhub, max_calls=5)
    assert len(finnhub.calls) == 5


def test_duplicates_and_rows_outside_the_window_are_dropped() -> None:
    def fetch(start: date, end: date) -> list[dict]:
        return [
            report("AMD", date(2026, 11, 3), "amc"),
            report("AMD", date(2026, 11, 3), "bmo"),
            report("OLD", TODAY - timedelta(days=1)),
        ]

    result = fetch_calendar(fetch, TODAY, TODAY + timedelta(days=60), max_calls=40)

    assert [(r.ticker, r.hour) for r in result.rows] == [("AMD", "amc")]


# --- Parsing -------------------------------------------------------------------


def test_parse_rows_validates_each_field() -> None:
    rows = parse_rows(
        [
            report("nvda", date(2026, 11, 17), "amc", 2.5259),
            {**report("XYZ", TODAY), "date": "not a date"},
            {**report("BAD TICKER", TODAY)},
            {**report("ODD", TODAY, "later"), "quarter": 7, "epsEstimate": True},
            "not a dict",
        ]
    )

    assert rows == [
        EarningsRow("NVDA", date(2026, 11, 17), "amc", 2.5259, None, 2026, 3),
        EarningsRow("ODD", TODAY, None, None, None, 2026, None),
    ]


def test_market_today_is_new_york_time() -> None:
    assert market_today(datetime(2026, 10, 20, 2, 0)) == date(2026, 10, 19)
    assert market_today(datetime(2026, 10, 20, 5, 0)) == date(2026, 10, 20)


# --- Pacing --------------------------------------------------------------------


def test_paced_waits_out_a_spent_shared_budget() -> None:
    attempts: list[int] = []
    sleeps: list[float] = []

    def fetch(start: date, end: date) -> list[dict]:
        attempts.append(1)
        if len(attempts) < 3:
            raise BudgetSpentError("spent")
        return []

    call = paced(fetch, SlidingWindowLimiter(0), sleep=sleeps.append, wait_seconds=5)

    assert call(TODAY, TODAY) == []
    assert sleeps == [5, 5]


def test_paced_gives_up_after_its_waits() -> None:
    def fetch(start: date, end: date) -> list[dict]:
        raise BudgetSpentError("spent")

    call = paced(fetch, SlidingWindowLimiter(0), sleep=lambda _: None, max_waits=2)

    with pytest.raises(BudgetSpentError):
        call(TODAY, TODAY)


def test_paced_keeps_its_own_pace() -> None:
    clock = [0.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    limiter = SlidingWindowLimiter(2, clock=lambda: clock[0], sleep=sleep)
    call = paced(lambda s, e: [], limiter)

    for _ in range(3):
        call(TODAY, TODAY)

    assert sleeps == [60.0]  # the third call waited for the minute to pass


# --- Service ---------------------------------------------------------------------


def state(**fields) -> RefreshState:
    base = dict(
        dataset=EARNINGS_CALENDAR,
        refreshed_at=NOW - timedelta(hours=2),
        attempted_at=NOW - timedelta(hours=2),
        refreshing_since=None,
        row_count=3,
        covered_from=TODAY,
        covered_to=TODAY + timedelta(days=60),
        last_error=None,
    )
    return RefreshState(**{**base, **fields})


class FakeStates:
    def __init__(self, current: RefreshState | None, claim: str | None = "r1"):
        self.current = current
        self.claim_id = claim
        self.failures: list[str] = []

    def get(self, dataset: str) -> RefreshState | None:
        return self.current

    def claim(self, dataset, policy, *, now=None) -> str | None:
        return self.claim_id

    def fail(self, dataset: str, refresh_id: str, error: str) -> None:
        self.failures.append(error)


class FakeEarnings:
    """Stores rows; answers next_per_ticker like the SQL does."""

    def __init__(self, rows: list[EarningsRow], keep_lease: bool = True):
        self.rows = rows
        self.keep_lease = keep_lease
        self.windows: list[tuple[date, date]] = []

    def next_per_ticker(self, tickers, start: date, end: date) -> list[EarningsRow]:
        self.windows.append((start, end))
        first: dict[str, EarningsRow] = {}
        for row in sorted(self.rows, key=lambda r: r.date):
            if row.ticker in tickers and start <= row.date <= end:
                first.setdefault(row.ticker, row)
        return list(first.values())

    def replace_all(self, rows, *, start, end, refresh_id, now) -> bool:
        if self.keep_lease:
            self.rows = list(rows)
        return self.keep_lease


class CountingRefresher(BackgroundRefresher):
    def __init__(self) -> None:
        super().__init__(max_workers=1)
        self.submitted = 0

    def submit(self, dataset, job) -> bool:
        self.submitted += 1
        return True


def row(ticker: str, day: date, hour: str | None = None) -> EarningsRow:
    return EarningsRow(ticker, day, hour, None, None, 2026, 3)


STORED = [
    row("AMD", date(2026, 11, 3), "amc"),
    row("NVDA", date(2026, 11, 17), "amc"),
    row("AAPL", date(2026, 10, 29), "amc"),
    row("MSFT", date(2026, 10, 28), "amc"),
    row("JPM", date(2026, 10, 14), "bmo"),  # already reported
    row("JPM", date(2027, 1, 13), "bmo"),  # past the 60-day window
    row("TSLA", date(2026, 10, 28), "bmo"),
    row("AMD", date(2026, 12, 15)),  # a later date for the same ticker
]


def make_service(states, earnings, fetch=None, refresher=None) -> EarningsService:
    def no_fetch(start: date, end: date) -> list[dict]:
        raise AssertionError("reading the calendar must not call Finnhub")

    return EarningsService(
        fetch=fetch or no_fetch,
        states=lambda: states,
        earnings=lambda: earnings,
        refresher=refresher or CountingRefresher(),
        policy=POLICY,
        days=60,
        max_calls=40,
        clock=lambda: NOW,
    )


def test_upcoming_keeps_the_next_report_in_the_window_soonest_first() -> None:
    earnings = FakeEarnings(STORED)
    service = make_service(FakeStates(state()), earnings)

    response = service.upcoming(
        ["amd", "JPM", "MSFT", "TSLA", "VOO", "AAPL", "NVDA"], 60
    )

    assert [(e.ticker, e.date.isoformat(), e.hour) for e in response.earnings] == [
        ("TSLA", "2026-10-28", "bmo"),  # before the open sorts first that day
        ("MSFT", "2026-10-28", "amc"),
        ("AAPL", "2026-10-29", "amc"),
        ("AMD", "2026-11-03", "amc"),
        ("NVDA", "2026-11-17", "amc"),
    ]
    assert response.unscheduled == ["JPM", "VOO"]
    assert (response.window_start, response.window_end) == (TODAY, date(2026, 12, 18))
    assert earnings.windows == [(TODAY, date(2026, 12, 18))]
    assert response.available and not response.refreshing


def test_a_shorter_window_filters_later_dates() -> None:
    service = make_service(FakeStates(state()), FakeEarnings(STORED))

    response = service.upcoming(["AMD", "NVDA"], 20)

    assert [e.ticker for e in response.earnings] == ["AMD"]
    assert response.unscheduled == ["NVDA"]


def test_an_empty_calendar_lists_every_ticker_unscheduled() -> None:
    response = make_service(FakeStates(state(row_count=0)), FakeEarnings([])).upcoming(
        ["AMD", "VOO"], 60
    )

    assert response.earnings == []
    assert response.unscheduled == ["AMD", "VOO"]
    assert response.available is True


def test_the_first_load_is_reported_as_refreshing() -> None:
    refresher = CountingRefresher()

    response = make_service(
        FakeStates(None), FakeEarnings([]), refresher=refresher
    ).upcoming(["AMD"], 60)

    assert response.refreshing and response.available
    assert refresher.submitted == 1


def test_a_calendar_that_never_loaded_is_unavailable() -> None:
    failed = state(refreshed_at=None, last_error="finnhub server error: 503")

    response = make_service(FakeStates(failed), FakeEarnings([])).upcoming(["AMD"], 60)

    assert response.available is False and response.refreshing is False


def test_no_database_is_unavailable_not_an_error() -> None:
    response = make_service(None, None).upcoming(["AMD"], 60)

    assert response == UpcomingEarningsResponse(
        unscheduled=["AMD"],
        window_start=TODAY,
        window_end=date(2026, 12, 18),
        available=False,
    )


def test_refresh_replaces_the_calendar() -> None:
    finnhub = CappedFinnhub([report("AMD", date(2026, 11, 3), "amc")])
    states, earnings = FakeStates(state()), FakeEarnings(STORED)

    assert make_service(states, earnings, fetch=finnhub).refresh() is True
    assert [(r.ticker, r.date) for r in earnings.rows] == [("AMD", date(2026, 11, 3))]
    assert finnhub.calls == [(TODAY, date(2026, 12, 18))]


def test_finnhub_down_keeps_the_stored_calendar() -> None:
    def down(start: date, end: date) -> list[dict]:
        raise ProviderUnavailableError("finnhub server error: 503")

    states, earnings = FakeStates(state()), FakeEarnings(STORED)

    assert make_service(states, earnings, fetch=down).refresh() is False
    assert earnings.rows == STORED
    assert states.failures == ["finnhub server error: 503"]


def test_refresh_without_the_lease_does_nothing() -> None:
    finnhub = CappedFinnhub([])

    assert (
        make_service(
            FakeStates(state(), claim=None), FakeEarnings([]), finnhub
        ).refresh()
        is False
    )
    assert finnhub.calls == []


# --- Route -------------------------------------------------------------------------


class StubService:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], int]] = []

    def upcoming(self, symbols, days) -> UpcomingEarningsResponse:
        self.calls.append((list(symbols), days))
        return UpcomingEarningsResponse(
            unscheduled=list(symbols), window_start=TODAY, window_end=TODAY
        )


@pytest.fixture
def stub() -> Iterator[StubService]:
    stub = StubService()
    app.dependency_overrides[get_earnings_service] = lambda: stub
    yield stub
    app.dependency_overrides.clear()


def test_route_answers(stub: StubService) -> None:
    response = TestClient(app).post(
        "/earnings/upcoming", json={"symbols": ["AMD"]}, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 200
    assert response.json()["unscheduled"] == ["AMD"]
    assert stub.calls == [(["AMD"], 60)]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"symbols": []},
        {"symbols": ["AMD"], "days": 61},
        {"symbols": ["AMD"], "days": 0},
    ],
)
def test_route_validates_input(stub: StubService, body: dict) -> None:
    response = TestClient(app).post(
        "/earnings/upcoming", json=body, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 422
    assert stub.calls == []


def test_route_requires_the_internal_token(stub: StubService) -> None:
    response = TestClient(app).post("/earnings/upcoming", json={"symbols": ["AMD"]})

    assert response.status_code == 401
