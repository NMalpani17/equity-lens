"""Company search: query handling, the service and the route (no database).

The ranking SQL itself runs against Postgres in test_market_symbols_pg.py.
"""

from collections.abc import Iterator
from datetime import datetime, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.symbol import SymbolMatch, SymbolSearchResponse
from app.services.market_data.refresh import BackgroundRefresher, RefreshPolicy
from app.services.market_data.symbols import (
    MAX_RESULTS,
    SymbolService,
    get_symbol_service,
    search_params,
)
from tests.conftest import INTERNAL_HEADERS

NOW = datetime(2026, 10, 19, 15, 0)
MSFT = SymbolMatch(ticker="MSFT", name="Microsoft Corp", type="stock", exchange="XNAS")


def test_search_params_for_a_ticker_like_query() -> None:
    params = search_params("  msft ", 8)

    assert params["ticker"] == "MSFT"
    assert params["ticker_prefix"] == "MSFT%"
    assert params["name"] == "msft"
    assert params["name_prefix"] == "msft%"
    assert params["word_prefix"] == "% msft%"
    assert params["fuzzy"] is True
    assert params["limit"] == 8


def test_search_params_for_a_name_query() -> None:
    params = search_params("Bank of  America", 8)

    # Spaces can't be in a ticker, so the ticker tiers can't match.
    assert params["ticker"] == "~" and params["ticker_prefix"] == "~"
    assert params["name"] == "bank of america"


def test_search_params_short_queries_skip_fuzzy() -> None:
    assert search_params("ms", 8)["fuzzy"] is False


def test_search_params_keep_wildcards_out() -> None:
    params = search_params("50%_off", 8)

    assert "%" not in params["name"] and "_" not in params["name"]
    assert params["ticker"] == "~"


@pytest.mark.parametrize("query", ["", "   ", "%%%", "__"])
def test_search_params_none_when_nothing_could_match(query: str) -> None:
    assert search_params(query, 8) is None


class FakeSymbols:
    def __init__(self, results=None, stored=True, broken=False):
        self.results = results or []
        self.stored = stored
        self.broken = broken
        self.queries: list[tuple[str, int]] = []

    def search(self, query: str, limit: int) -> list[SymbolMatch]:
        if self.broken:
            raise psycopg.OperationalError("connection lost")
        self.queries.append((query, limit))
        return self.results

    def has_any(self) -> bool:
        return self.stored


class CountingRefresher(BackgroundRefresher):
    def __init__(self) -> None:
        super().__init__(max_workers=1)
        self.submitted = 0

    def submit(self, dataset, job) -> bool:
        self.submitted += 1
        return True


class NoStates:
    def get(self, dataset):
        return None  # never refreshed: due


def service(symbols, refresher=None, fetch=None) -> SymbolService:
    def no_fetch() -> list[dict]:
        raise AssertionError("searching must not call Finnhub")

    return SymbolService(
        fetch_list=fetch or no_fetch,
        states=lambda: NoStates(),
        symbols=lambda: symbols,
        refresher=refresher or CountingRefresher(),
        policy=RefreshPolicy(
            max_age=timedelta(hours=24),
            retry_after=timedelta(minutes=30),
            stale_after=timedelta(minutes=10),
        ),
        clock=lambda: NOW,
    )


def test_search_reads_postgres_and_starts_a_background_refresh() -> None:
    symbols, refresher = FakeSymbols([MSFT]), CountingRefresher()

    response = service(symbols, refresher).search("micro")

    assert response == SymbolSearchResponse(results=[MSFT], ready=True)
    assert symbols.queries == [("micro", MAX_RESULTS)]
    assert refresher.submitted == 1  # in the background; Finnhub not called here


def test_no_match_is_still_ready_when_the_list_is_loaded() -> None:
    assert service(FakeSymbols()).search("zzzz") == SymbolSearchResponse(ready=True)


def test_an_empty_list_is_not_ready() -> None:
    response = service(FakeSymbols(stored=False)).search("msft")

    assert response == SymbolSearchResponse(ready=False)


def test_a_database_error_is_an_empty_not_ready_answer() -> None:
    response = service(FakeSymbols(broken=True)).search("msft")

    assert response == SymbolSearchResponse(ready=False)


def test_no_database_is_an_empty_not_ready_answer() -> None:
    assert service(None).search("msft") == SymbolSearchResponse(ready=False)


class StubService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def search(self, query: str, limit: int) -> SymbolSearchResponse:
        self.calls.append((query, limit))
        return SymbolSearchResponse(results=[MSFT], ready=True)


@pytest.fixture
def stub() -> Iterator[StubService]:
    stub = StubService()
    app.dependency_overrides[get_symbol_service] = lambda: stub
    yield stub
    app.dependency_overrides.clear()


def test_route_returns_matches(stub: StubService) -> None:
    response = TestClient(app).get(
        "/symbols/search", params={"q": "micro"}, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 200
    assert response.json() == {
        "results": [
            {
                "ticker": "MSFT",
                "name": "Microsoft Corp",
                "type": "stock",
                "exchange": "XNAS",
            }
        ],
        "ready": True,
    }
    assert stub.calls == [("micro", MAX_RESULTS)]


@pytest.mark.parametrize(
    "params", [{}, {"q": ""}, {"q": "x" * 51}, {"q": "a", "limit": 9}]
)
def test_route_validates_input(stub: StubService, params: dict) -> None:
    response = TestClient(app).get(
        "/symbols/search", params=params, headers=INTERNAL_HEADERS
    )

    assert response.status_code == 422
    assert stub.calls == []


def test_route_requires_the_internal_token(stub: StubService) -> None:
    response = TestClient(app).get("/symbols/search", params={"q": "msft"})

    assert response.status_code == 401
