"""Tests for the price history service (fetcher mocked)."""

from datetime import date, timedelta

import pytest

from app.services.market_data.base import QuoteNotFoundError
from app.services.market_data.history import PriceHistoryService, downsample
from app.services.rag.cache import TTLCache


def rows(n: int) -> list[tuple[date, float]]:
    start = date(2026, 1, 1)
    return [(start + timedelta(days=i), 100.0 + i) for i in range(n)]


def test_summarizes_and_downsamples_history() -> None:
    calls: list[tuple[str, str, str]] = []

    def fetcher(symbol: str, period: str, interval: str):
        calls.append((symbol, period, interval))
        series = rows(120)
        series[10] = (series[10][0], 500.0)  # spike -> high
        series[20] = (series[20][0], 50.0)  # dip -> low
        return series, "USD"

    service = PriceHistoryService(fetcher, TTLCache(10, 60))
    history = service.get_history(" aapl ", "6mo")

    assert calls == [("AAPL", "6mo", "1d")]
    assert history.first_close == 100.0 and history.last_close == 219.0
    assert history.change == 119.0 and history.change_percent == 119.0
    assert history.high == 500.0 and history.high_date == date(2026, 1, 11)
    assert history.low == 50.0 and history.low_date == date(2026, 1, 21)
    assert len(history.points) == 60
    assert history.points[0].date == date(2026, 1, 1)
    assert history.points[-1].date == history.end_date

    service.get_history("AAPL", "6mo")
    assert len(calls) == 1  # cached


def test_long_periods_use_weekly_bars() -> None:
    seen: list[str] = []

    def fetcher(symbol: str, period: str, interval: str):
        seen.append(interval)
        return rows(5), "USD"

    PriceHistoryService(fetcher, TTLCache(10, 60)).get_history("MSFT", "5y")

    assert seen == ["1wk"]


def test_unknown_ticker_raises_not_found() -> None:
    service = PriceHistoryService(lambda *_: ([], ""), TTLCache(10, 60))

    with pytest.raises(QuoteNotFoundError):
        service.get_history("ZZZZ", "1mo")


def test_downsample_keeps_endpoints() -> None:
    assert downsample(list(range(10)), 60) == list(range(10))
    thinned = downsample(list(range(1000)), 5)
    assert thinned[0] == 0 and thinned[-1] == 999 and len(thinned) == 5
