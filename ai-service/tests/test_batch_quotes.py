"""Batch quotes on a fixed Finnhub budget (the watchlist)."""

from collections.abc import Iterator
from datetime import UTC, datetime

import pandas as pd
import pytest
import yfinance as yf
from fastapi.testclient import TestClient

from app.main import app
from app.models.quote import Quote, QuotesResponse
from app.services.market_data.base import (
    BudgetSpentError,
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from app.services.market_data.batch_quotes import (
    BatchQuoteService,
    get_batch_quote_service,
    yfinance_batch_quotes,
)
from app.services.market_data.cache import QuoteCache
from app.services.market_data.service import MarketDataService
from tests.conftest import INTERNAL_HEADERS


def quote(ticker: str, price: float = 100.0, provider: str = "finnhub") -> Quote:
    return Quote.build(
        ticker=ticker,
        price=price,
        previous_close=price - 1,
        provider=provider,
        as_of=datetime.now(UTC),
    )


class FakeProvider:
    name = "fake"

    def get_quote(self, ticker: str) -> Quote:
        raise AssertionError("the batch path never uses the provider chain")


class Finnhub:
    def __init__(self, not_found=(), down=()):
        self.not_found, self.down = set(not_found), set(down)
        self.calls: list[str] = []

    def __call__(self, ticker: str) -> Quote:
        self.calls.append(ticker)
        if ticker in self.not_found:
            raise QuoteNotFoundError(ticker)
        if ticker in self.down:
            raise BudgetSpentError("spent")
        return quote(ticker)


class Download:
    def __init__(self, known=None, broken=False):
        self.known = known
        self.broken = broken
        self.calls: list[list[str]] = []

    def __call__(self, symbols: list[str]) -> dict[str, Quote]:
        self.calls.append(list(symbols))
        if self.broken:
            raise ProviderUnavailableError("yfinance down")
        known = self.known if self.known is not None else symbols
        return {s: quote(s, provider="yfinance") for s in symbols if s in known}


def make(finnhub, download, budget=15):
    market = MarketDataService([FakeProvider()], QuoteCache(ttl_seconds=60))
    service = BatchQuoteService(
        market=market,
        finnhub_price=finnhub,
        batch_download=download,
        finnhub_budget=budget,
    )
    return service, market


def watchlist(n: int = 50) -> list[str]:
    return [f"T{i:02d}" for i in range(n)]


def test_fifty_cold_tickers_spend_fifteen_finnhub_calls_and_one_download() -> None:
    finnhub, download = Finnhub(), Download()
    service, _ = make(finnhub, download)

    response = service.get_quotes(watchlist())

    assert len(finnhub.calls) == 15
    assert finnhub.calls == watchlist()[:15]
    assert download.calls == [watchlist()[15:]]
    assert len(response.quotes) == 50 and response.errors == {}


def test_a_warm_cache_spends_nothing() -> None:
    finnhub, download = Finnhub(), Download()
    service, _ = make(finnhub, download)
    service.get_quotes(watchlist())
    finnhub.calls.clear()
    download.calls.clear()

    response = service.get_quotes(watchlist())

    assert finnhub.calls == [] and download.calls == []
    assert len(response.quotes) == 50


def test_batch_results_fill_the_shared_cache() -> None:
    service, market = make(Finnhub(), Download())

    service.get_quotes(["AMD", "JPM"])

    assert market.cached_quote("AMD") is not None
    assert market.cached_quote("JPM") is not None


def test_portfolio_quotes_in_the_cache_are_reused() -> None:
    finnhub, download = Finnhub(), Download()
    service, market = make(finnhub, download)
    market.remember(quote("AMD", 150.0))

    response = service.get_quotes(["AMD"])

    assert response.quotes["AMD"].price == 150.0
    assert finnhub.calls == [] and download.calls == []


def test_finnhub_misses_fall_back_to_the_download() -> None:
    finnhub = Finnhub(not_found={"NEWCO"}, down={"JPM"})
    download = Download(known={"NEWCO", "JPM"})
    service, _ = make(finnhub, download)

    response = service.get_quotes(["AMD", "NEWCO", "JPM"])

    assert download.calls == [["NEWCO", "JPM"]]
    assert set(response.quotes) == {"AMD", "NEWCO", "JPM"}


def test_unknown_everywhere_is_not_found_and_otherwise_unavailable() -> None:
    finnhub = Finnhub(not_found={"ZZZZ"})
    service, _ = make(finnhub, Download(known=set()), budget=1)

    response = service.get_quotes(["ZZZZ", "LATE"])

    # ZZZZ: Finnhub said unknown and yfinance had nothing. LATE never reached
    # Finnhub (past the budget), so it's only unavailable.
    assert response.errors == {"ZZZZ": "not_found", "LATE": "unavailable"}


def test_a_failed_download_marks_the_rest_unavailable() -> None:
    service, _ = make(Finnhub(), Download(broken=True), budget=1)

    response = service.get_quotes(["AMD", "JPM"])

    assert set(response.quotes) == {"AMD"}
    assert response.errors == {"JPM": "unavailable"}


def test_duplicates_and_case_are_normalized() -> None:
    finnhub = Finnhub()
    service, _ = make(finnhub, Download())

    response = service.get_quotes(["amd", "AMD", " jpm "])

    assert finnhub.calls == ["AMD", "JPM"]
    assert set(response.quotes) == {"AMD", "JPM"}


def frame(closes: dict[str, list[float]]) -> pd.DataFrame:
    index = pd.to_datetime(["2026-10-16", "2026-10-19"])
    columns = pd.MultiIndex.from_tuples([("Close", t) for t in closes])
    return pd.DataFrame(
        list(zip(*closes.values(), strict=True)), index=index, columns=columns
    )


def test_yfinance_batch_quotes_reads_last_and_previous_close(monkeypatch) -> None:
    asked: list[list[str]] = []

    def download(symbols, **kwargs):
        asked.append(symbols)
        return frame(
            {"AMD": [150.0, 153.0], "BRK-B": [480.0, 470.0], "GONE": [1.0, None]}
        )

    monkeypatch.setattr(yf, "download", download)

    quotes = yfinance_batch_quotes(["AMD", "BRK.B", "GONE", "NOPE"])

    assert asked == [["AMD", "BRK-B", "GONE", "NOPE"]]
    assert set(quotes) == {"AMD", "BRK.B"}
    assert quotes["AMD"].price == 153.0 and quotes["AMD"].previous_close == 150.0
    assert quotes["BRK.B"].change == -10.0
    assert quotes["AMD"].provider == "yfinance" and quotes["AMD"].name is None


def test_yfinance_batch_quotes_raises_when_yahoo_is_down(monkeypatch) -> None:
    monkeypatch.setattr(yf, "download", lambda *a, **k: pd.DataFrame())

    with pytest.raises(ProviderUnavailableError):
        yfinance_batch_quotes(["AMD"])


class StubBatch:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def get_quotes(self, symbols) -> QuotesResponse:
        self.calls.append(list(symbols))
        return QuotesResponse(quotes={"AMD": quote("AMD")})


@pytest.fixture
def stub() -> Iterator[StubBatch]:
    stub = StubBatch()
    app.dependency_overrides[get_batch_quote_service] = lambda: stub
    yield stub
    app.dependency_overrides.clear()


def test_batch_route_is_not_taken_for_a_ticker(stub: StubBatch) -> None:
    response = TestClient(app).get(
        "/quotes/batch", params={"symbols": "amd,JPM"}, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 200
    assert response.json()["quotes"]["AMD"]["price"] == 100.0
    assert stub.calls == [["AMD", "JPM"]]


def test_batch_route_validates_symbols(stub: StubBatch) -> None:
    response = TestClient(app).get(
        "/quotes/batch", params={"symbols": " , "}, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 422
    assert stub.calls == []
