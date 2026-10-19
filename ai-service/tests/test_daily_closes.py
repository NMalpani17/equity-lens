"""Tests for the Postgres-cached daily closes (yfinance and database faked)."""

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
import psycopg
import pytest

from app.services.market_data.base import ProviderUnavailableError
from app.services.market_data.daily_closes import (
    DailyClosesService,
    FetchedHistory,
    fetch_yfinance_daily,
    last_completed_session,
    yahoo_symbol,
)
from app.services.market_data.repository import STATUS_NO_HISTORY, Coverage
from tests.market_fakes import FakeMarketRepository

# Friday Oct 16, 2026, 5pm in New York: Friday's session is final.
FRIDAY_EVENING = datetime(2026, 10, 16, 21, 0, tzinfo=UTC)
FRIDAY = date(2026, 10, 16)


def weekdays(start: date, end: date, base: float = 100.0) -> list[tuple[date, float]]:
    rows, day, price = [], start, base
    while day <= end:
        if day.weekday() < 5:
            rows.append((day, price))
            price += 1.0
        day += timedelta(days=1)
    return rows


class FakeFetcher:
    """Serves a fixed "true" history per symbol, recording each call."""

    def __init__(self, history: dict[str, list[tuple[date, float]]]) -> None:
        self.history = history
        self.splits: dict[str, list[date]] = {}
        self.calls: list[tuple[str, date]] = []
        self.down = False

    def __call__(self, symbol: str, start: date) -> FetchedHistory:
        self.calls.append((symbol, start))
        if self.down:
            raise ProviderUnavailableError("yfinance down")
        rows = [(d, c) for d, c in self.history.get(symbol, []) if d >= start]
        return FetchedHistory(rows, self.splits.get(symbol, []))


def make_service(fetcher, repo, now=FRIDAY_EVENING) -> DailyClosesService:
    clock = SimpleNamespace(now=now)
    return DailyClosesService(fetcher, lambda: repo, clock=lambda: clock.now)


def test_session_is_final_after_the_close_in_new_york() -> None:
    assert last_completed_session(datetime(2026, 10, 16, 20, 0, tzinfo=UTC)) == date(
        2026, 10, 15
    )  # 4pm ET: not yet final
    assert last_completed_session(FRIDAY_EVENING) == FRIDAY


def test_yahoo_symbols_use_a_dash_for_share_classes() -> None:
    assert yahoo_symbol("BRK.B") == "BRK-B"
    assert yahoo_symbol("AAPL") == "AAPL"


def test_cold_request_fetches_stores_and_then_serves_from_cache() -> None:
    fetcher = FakeFetcher({"AAPL": weekdays(date(2026, 9, 1), FRIDAY)})
    repo = FakeMarketRepository()
    service = make_service(fetcher, repo)

    first = service.get_closes(["AAPL"], date(2026, 10, 1))
    second = service.get_closes(["AAPL"], date(2026, 10, 1))

    assert fetcher.calls == [("AAPL", date(2026, 10, 1))]
    assert first.series["AAPL"] == second.series["AAPL"]
    assert first.series["AAPL"][0].date == date(2026, 10, 1)
    assert first.series["AAPL"][-1].date == FRIDAY
    assert repo.coverage_by_ticker["AAPL"].fetched_through == FRIDAY


def test_the_current_session_is_never_stored() -> None:
    # Monday 11am in New York: Monday's bar is intraday.
    monday_morning = datetime(2026, 10, 19, 15, 0, tzinfo=UTC)
    fetcher = FakeFetcher({"AAPL": weekdays(date(2026, 10, 1), date(2026, 10, 19))})
    repo = FakeMarketRepository()

    result = make_service(fetcher, repo, monday_morning).get_closes(
        ["AAPL"], date(2026, 10, 1)
    )

    assert result.through == date(2026, 10, 18)
    assert result.series["AAPL"][-1].date == FRIDAY
    assert date(2026, 10, 19) not in repo.closes_by_ticker["AAPL"]


def test_new_sessions_fetch_only_the_tail() -> None:
    history = weekdays(date(2026, 9, 1), date(2026, 10, 23))
    fetcher = FakeFetcher({"AAPL": history})
    repo = FakeMarketRepository()
    make_service(fetcher, repo).get_closes(["AAPL"], date(2026, 10, 1))

    next_friday = FRIDAY_EVENING + timedelta(days=7)
    result = make_service(fetcher, repo, next_friday).get_closes(
        ["AAPL"], date(2026, 10, 1)
    )

    # Tail fetch from the last fill minus the overlap, without replacing.
    assert fetcher.calls[1] == ("AAPL", FRIDAY - timedelta(days=10))
    assert repo.replaced == ["AAPL"]  # only the first, cold fill
    assert result.series["AAPL"][-1].date == date(2026, 10, 23)
    assert repo.coverage_by_ticker["AAPL"].covered_from == date(2026, 10, 1)


def test_a_split_since_the_last_fill_replaces_the_history() -> None:
    fetcher = FakeFetcher({"NVDA": weekdays(date(2026, 9, 1), date(2026, 10, 23))})
    repo = FakeMarketRepository()
    make_service(fetcher, repo).get_closes(["NVDA"], date(2026, 10, 1))

    # A 2:1 split on Oct 21 halves every earlier close.
    fetcher.history["NVDA"] = [
        (d, c / 2 if d < date(2026, 10, 21) else c) for d, c in fetcher.history["NVDA"]
    ]
    fetcher.splits["NVDA"] = [date(2026, 10, 21)]
    result = make_service(fetcher, repo, FRIDAY_EVENING + timedelta(days=7)).get_closes(
        ["NVDA"], date(2026, 10, 1)
    )

    assert repo.replaced == ["NVDA", "NVDA"]
    assert fetcher.calls[-1] == ("NVDA", date(2026, 10, 1))
    first = result.series["NVDA"][0]
    assert first.date == date(2026, 10, 1) and first.close == pytest.approx(
        dict(fetcher.history["NVDA"])[date(2026, 10, 1)]
    )


def test_changed_stored_closes_replace_the_history_even_without_a_split() -> None:
    fetcher = FakeFetcher({"MSFT": weekdays(date(2026, 9, 1), date(2026, 10, 23))})
    repo = FakeMarketRepository()
    make_service(fetcher, repo).get_closes(["MSFT"], date(2026, 10, 1))

    fetcher.history["MSFT"] = [(d, c * 0.9) for d, c in fetcher.history["MSFT"]]
    make_service(fetcher, repo, FRIDAY_EVENING + timedelta(days=7)).get_closes(
        ["MSFT"], date(2026, 10, 1)
    )

    assert repo.replaced == ["MSFT", "MSFT"]


def test_an_earlier_start_than_cached_refetches_from_it() -> None:
    fetcher = FakeFetcher({"AAPL": weekdays(date(2026, 1, 1), FRIDAY)})
    repo = FakeMarketRepository()
    service = make_service(fetcher, repo)
    service.get_closes(["AAPL"], date(2026, 10, 1))

    result = service.get_closes(["AAPL"], date(2026, 6, 1))

    assert fetcher.calls[-1] == ("AAPL", date(2026, 6, 1))
    assert result.series["AAPL"][0].date == date(2026, 6, 1)
    assert repo.coverage_by_ticker["AAPL"].covered_from == date(2026, 6, 1)


def test_tickers_without_history_are_errors_and_retried_after_a_day() -> None:
    fetcher = FakeFetcher({"SPY": weekdays(date(2026, 9, 1), FRIDAY)})
    repo = FakeMarketRepository()

    result = make_service(fetcher, repo).get_closes(["ZZZZ"], date(2026, 10, 1))
    assert result.errors == {"ZZZZ": "not_found"} and not result.series
    assert repo.coverage_by_ticker["ZZZZ"].status == STATUS_NO_HISTORY
    # SPY was asked to prove Yahoo was answering.
    assert [symbol for symbol, _ in fetcher.calls] == ["ZZZZ", "SPY"]

    # Within a day: answered from the cache without asking yfinance.
    repo.coverage_by_ticker["ZZZZ"] = Coverage(
        "ZZZZ", date(2026, 10, 1), FRIDAY, STATUS_NO_HISTORY, datetime(2026, 10, 16, 12)
    )
    make_service(fetcher, repo).get_closes(["ZZZZ"], date(2026, 10, 1))
    assert len(fetcher.calls) == 2

    # A day later: asked again.
    make_service(fetcher, repo, FRIDAY_EVENING + timedelta(days=1)).get_closes(
        ["ZZZZ"], date(2026, 10, 1)
    )
    assert fetcher.calls[2][0] == "ZZZZ"


def test_empty_history_while_yahoo_is_unreachable_is_not_cached() -> None:
    # yfinance returns nothing for every symbol (a swallowed network error).
    fetcher = FakeFetcher({})
    repo = FakeMarketRepository()

    result = make_service(fetcher, repo).get_closes(["AAPL"], date(2026, 10, 1))
    uncached = DailyClosesService(
        fetcher, lambda: None, clock=lambda: FRIDAY_EVENING
    ).get_closes(["AAPL"], date(2026, 10, 1))

    assert result.errors == {"AAPL": "unavailable"}
    assert uncached.errors == {"AAPL": "unavailable"}
    assert repo.coverage_by_ticker == {}


def test_an_outage_serves_stale_closes_or_reports_unavailable() -> None:
    fetcher = FakeFetcher({"AAPL": weekdays(date(2026, 9, 1), FRIDAY)})
    repo = FakeMarketRepository()
    make_service(fetcher, repo).get_closes(["AAPL"], date(2026, 10, 1))
    fetcher.down = True

    result = make_service(fetcher, repo, FRIDAY_EVENING + timedelta(days=3)).get_closes(
        ["AAPL", "MSFT"], date(2026, 10, 1)
    )

    assert result.series["AAPL"][-1].date == FRIDAY
    assert result.errors == {"MSFT": "unavailable"}


def test_without_a_database_closes_are_fetched_directly() -> None:
    fetcher = FakeFetcher({"SPY": weekdays(date(2026, 10, 1), FRIDAY)})
    service = DailyClosesService(fetcher, lambda: None, clock=lambda: FRIDAY_EVENING)

    result = service.get_closes(["SPY"], date(2026, 10, 5))

    assert result.series["SPY"][0].date == date(2026, 10, 5)


def test_a_database_failure_falls_back_to_fetching() -> None:
    class BrokenRepo(FakeMarketRepository):
        def coverage(self, tickers):
            raise psycopg.OperationalError("connection lost")

    fetcher = FakeFetcher({"SPY": weekdays(date(2026, 10, 1), FRIDAY)})

    result = make_service(fetcher, BrokenRepo()).get_closes(["SPY"], date(2026, 10, 1))

    assert "SPY" in result.series


def test_start_is_clamped_to_the_last_session() -> None:
    fetcher = FakeFetcher({"SPY": weekdays(date(2026, 10, 1), FRIDAY)})

    make_service(fetcher, FakeMarketRepository()).get_closes(["SPY"], date(2030, 1, 1))

    assert fetcher.calls == [("SPY", FRIDAY)]


def test_yfinance_fetch_reads_split_adjusted_closes_and_splits() -> None:
    index = pd.to_datetime(["2026-10-14", "2026-10-15", "2026-10-16"])
    frame = pd.DataFrame(
        {"Close": [10.0, float("nan"), 12.0], "Stock Splits": [0.0, 0.0, 2.0]},
        index=index,
    )
    ticker = SimpleNamespace(history=lambda **kwargs: frame)

    with patch(
        "app.services.market_data.daily_closes.yf.Ticker", return_value=ticker
    ) as make:
        fetched = fetch_yfinance_daily("BRK.B", date(2026, 10, 14))

    make.assert_called_once_with("BRK-B")
    assert fetched.rows == [(date(2026, 10, 14), 10.0), (date(2026, 10, 16), 12.0)]
    assert fetched.split_dates == [date(2026, 10, 16)]


def test_yfinance_errors_mean_unavailable() -> None:
    def boom(**kwargs):
        raise RuntimeError("rate limited")

    with patch(
        "app.services.market_data.daily_closes.yf.Ticker",
        return_value=SimpleNamespace(history=boom),
    ):
        with pytest.raises(ProviderUnavailableError):
            fetch_yfinance_daily("AAPL", date(2026, 10, 1))
