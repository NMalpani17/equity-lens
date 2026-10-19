"""Tests for the batch ticker check used by holdings imports."""

from collections.abc import Iterator
from datetime import date, datetime
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.market_data.base import ProviderUnavailableError
from app.services.market_data.repository import Coverage, StoredProfile
from app.services.market_data.tickers import (
    TickerVerifier,
    get_ticker_verifier,
    yfinance_batch_check,
)
from app.services.rag.cache import TTLCache
from tests.conftest import INTERNAL_HEADERS
from tests.market_fakes import FakeMarketRepository

T0 = datetime(2026, 10, 16, 21, 0)
REAL = {"AAPL", "MSFT", "NVDA", "VOO"}


class Calls:
    def __init__(self) -> None:
        self.batch: list[list[str]] = []
        self.finnhub: list[str] = []


def make_verifier(
    calls: Calls,
    *,
    repo: FakeMarketRepository | None = None,
    quoted: set[str] = frozenset(),
    yfinance_down: bool = False,
    finnhub_budget: int = 20,
) -> TickerVerifier:
    def batch_check(symbols: list[str]) -> dict[str, bool]:
        calls.batch.append(symbols)
        if yfinance_down:
            raise ProviderUnavailableError("down")
        return {s: s in REAL for s in symbols}

    def finnhub_has_quote(symbol: str) -> bool:
        calls.finnhub.append(symbol)
        return symbol in REAL

    return TickerVerifier(
        cached_quote=lambda s: object() if s in quoted else None,
        repository=lambda: repo,
        batch_check=batch_check,
        finnhub_has_quote=finnhub_has_quote,
        finnhub_budget=finnhub_budget,
        memo=TTLCache(100, 3600),
    )


def test_dedupes_and_settles_cached_tickers_without_any_provider() -> None:
    repo = FakeMarketRepository()
    repo.stored_profiles["NVDA"] = StoredProfile(
        "NVDA", "NVIDIA", "Information Technology", None, "finnhub", T0
    )
    repo.coverage_by_ticker["VOO"] = Coverage(
        "VOO", date(2026, 1, 1), date(2026, 10, 16), "ok", T0
    )
    calls = Calls()
    verifier = make_verifier(calls, repo=repo, quoted={"AAPL"})

    results = verifier.verify(["aapl", "AAPL ", "NVDA", "VOO", "MSFT", "ZZZZ"])

    assert results == {
        "AAPL": "ok",
        "NVDA": "ok",
        "VOO": "ok",
        "MSFT": "ok",
        "ZZZZ": "not_found",
    }
    # One batched yfinance download for what no cache knew; no Finnhub.
    assert calls.batch == [["MSFT", "ZZZZ"]]
    assert calls.finnhub == []


def test_results_are_memoized_so_the_save_rechecks_for_free() -> None:
    calls = Calls()
    verifier = make_verifier(calls)

    verifier.verify(["MSFT", "ZZZZ"])
    again = verifier.verify(["MSFT", "ZZZZ"])

    assert again == {"MSFT": "ok", "ZZZZ": "not_found"}
    assert len(calls.batch) == 1


def test_a_500_ticker_import_spends_at_most_the_finnhub_budget() -> None:
    calls = Calls()
    symbols = [f"T{i:03d}" for i in range(500)]
    verifier = make_verifier(calls, yfinance_down=True, finnhub_budget=20)

    results = verifier.verify(symbols)

    assert len(calls.finnhub) == 20
    assert sum(r == "unavailable" for r in results.values()) == 480
    # Unchecked tickers aren't remembered, so a later try checks them.
    verifier.verify(symbols[25:26])
    assert calls.finnhub[-1] == "T025"


def test_falls_back_to_finnhub_while_yfinance_is_down() -> None:
    calls = Calls()

    results = make_verifier(calls, yfinance_down=True).verify(["MSFT", "ZZZZ"])

    assert results == {"MSFT": "ok", "ZZZZ": "not_found"}
    assert calls.finnhub == ["MSFT", "ZZZZ"]


def frame(closes: dict[str, list[float]]) -> pd.DataFrame:
    index = pd.to_datetime(["2026-10-15", "2026-10-16"])
    columns = pd.MultiIndex.from_tuples([("Close", t) for t in closes])
    return pd.DataFrame(
        list(zip(*closes.values(), strict=True)), index=index, columns=columns
    )


def test_yfinance_batch_check_reads_one_download() -> None:
    nan = float("nan")
    data = frame(
        {"AAPL": [1.0, 2.0], "BRK-B": [nan, 3.0], "ZZZZ": [nan, nan], "SPY": [5.0, 6.0]}
    )

    with patch(
        "app.services.market_data.tickers.yf.download", return_value=data
    ) as download:
        result = yfinance_batch_check(["AAPL", "BRK.B", "ZZZZ"])

    assert download.call_args.args[0] == ["AAPL", "BRK-B", "ZZZZ", "SPY"]
    assert result == {"AAPL": True, "BRK.B": True, "ZZZZ": False}


def test_yfinance_batch_check_without_spy_prices_is_an_outage() -> None:
    nan = float("nan")
    data = frame({"AAPL": [nan, nan], "SPY": [nan, nan]})

    with patch("app.services.market_data.tickers.yf.download", return_value=data):
        with pytest.raises(ProviderUnavailableError):
            yfinance_batch_check(["AAPL"])


class StubVerifier:
    def verify(self, symbols: list[str]) -> dict[str, str]:
        return {s.upper(): "ok" for s in symbols}


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_ticker_verifier] = lambda: StubVerifier()
    yield TestClient(app, headers=INTERNAL_HEADERS)
    app.dependency_overrides.clear()


def test_verify_route(client: TestClient) -> None:
    res = client.post("/tickers/verify", json={"symbols": ["aapl", "VOO"]})

    assert res.status_code == 200
    assert res.json() == {"results": {"AAPL": "ok", "VOO": "ok"}}


@pytest.mark.parametrize(
    "body",
    [
        {"symbols": []},
        {"symbols": [f"T{i}" for i in range(501)]},
        {"symbols": ["X" * 13]},
    ],
)
def test_verify_route_rejects_bad_bodies(client: TestClient, body) -> None:
    assert client.post("/tickers/verify", json=body).status_code == 422
