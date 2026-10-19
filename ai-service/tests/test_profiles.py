"""Tests for company profiles and sector mapping (providers and database faked)."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.profile import CompanyProfile, ProfilesResponse
from app.services.market_data.base import ProviderUnavailableError
from app.services.market_data.profiles import ProfileService, get_profile_service
from app.services.market_data.repository import StoredProfile
from app.services.market_data.sectors import (
    FUNDS,
    sector_from_finnhub,
    sector_from_yahoo,
)
from tests.conftest import INTERNAL_HEADERS
from tests.market_fakes import FakeMarketRepository

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


class FakeProvider:
    def __init__(self, payloads: dict[str, dict[str, Any]], down: bool = False):
        self.payloads = payloads
        self.down = down
        self.calls: list[str] = []

    def __call__(self, symbol: str) -> dict[str, Any]:
        self.calls.append(symbol)
        if self.down:
            raise ProviderUnavailableError("down")
        return self.payloads.get(symbol, {})


FINNHUB = {
    "AAPL": {"name": "Apple Inc", "finnhubIndustry": "Technology"},
    "NVDA": {"name": "NVIDIA Corp", "finnhubIndustry": "Semiconductors"},
    "ODD": {"name": "Odd Co", "finnhubIndustry": "N/A"},
}
YAHOO = {
    "VOO": {"quoteType": "ETF", "longName": "Vanguard S&P 500 ETF"},
    "ODD": {"quoteType": "EQUITY", "sector": "Consumer Cyclical"},
    "SHOP": {"quoteType": "EQUITY", "sector": "Technology", "shortName": "Shopify"},
}


def make_service(finnhub, yahoo, repo, **kwargs) -> ProfileService:
    return ProfileService(finnhub, yahoo, lambda: repo, clock=lambda: NOW, **kwargs)


@pytest.mark.parametrize(
    ("industry", "sector"),
    [
        ("Technology", "Information Technology"),
        ("Semiconductors", "Information Technology"),
        ("Banking", "Financials"),
        ("Media", "Communication Services"),
        ("Retail", "Consumer Discretionary"),
        ("Pharmaceuticals", "Health Care"),
        ("  metals & MINING ", "Materials"),
        ("Real Estate", "Real Estate"),
        ("N/A", None),
        (None, None),
    ],
)
def test_finnhub_industries_map_to_gics_sectors(industry, sector) -> None:
    assert sector_from_finnhub(industry) == sector


@pytest.mark.parametrize(
    ("sector", "quote_type", "expected"),
    [
        ("Consumer Cyclical", "EQUITY", "Consumer Discretionary"),
        ("Consumer Defensive", "EQUITY", "Consumer Staples"),
        ("Healthcare", "EQUITY", "Health Care"),
        ("Basic Materials", None, "Materials"),
        ("Financial Services", "EQUITY", "Financials"),
        (None, "ETF", FUNDS),
        (None, "MUTUALFUND", FUNDS),
        ("", "EQUITY", None),
    ],
)
def test_yahoo_sectors_and_funds_map_to_the_same_taxonomy(
    sector, quote_type, expected
) -> None:
    assert sector_from_yahoo(sector, quote_type) == expected


def test_finnhub_first_then_yahoo_and_results_are_cached() -> None:
    finnhub, yahoo = FakeProvider(FINNHUB), FakeProvider(YAHOO)
    repo = FakeMarketRepository()
    service = make_service(finnhub, yahoo, repo)

    result = service.get_profiles(["AAPL", "VOO", "ODD", "ZZZZ"])

    assert result.profiles["AAPL"].sector == "Information Technology"
    assert result.profiles["AAPL"].source == "finnhub"
    # ETFs have no Finnhub profile: Yahoo says it's a fund.
    assert result.profiles["VOO"].sector == FUNDS
    assert result.profiles["VOO"].name == "Vanguard S&P 500 ETF"
    # An unmapped Finnhub industry falls back to Yahoo, keeping Finnhub's name.
    assert result.profiles["ODD"].sector == "Consumer Discretionary"
    assert result.profiles["ODD"].name == "Odd Co"
    assert result.profiles["ZZZZ"].sector is None
    assert result.profiles["ZZZZ"].source == "none"
    assert result.pending == []
    assert set(repo.stored_profiles) == {"AAPL", "VOO", "ODD", "ZZZZ"}

    finnhub.calls.clear()
    yahoo.calls.clear()
    again = service.get_profiles(["AAPL", "VOO", "ODD", "ZZZZ"])

    assert again.profiles == result.profiles
    assert finnhub.calls == [] and yahoo.calls == []


def test_profiles_expire_after_their_ttl() -> None:
    repo = FakeMarketRepository()
    old = (NOW - timedelta(days=31)).replace(tzinfo=None)
    recent_unknown = (NOW - timedelta(days=3)).replace(tzinfo=None)
    repo.stored_profiles = {
        "AAPL": StoredProfile(
            "AAPL", "Apple", "Information Technology", None, "finnhub", old
        ),
        "ZZZZ": StoredProfile("ZZZZ", None, None, None, "none", recent_unknown),
    }
    finnhub = FakeProvider(FINNHUB)

    make_service(finnhub, FakeProvider(YAHOO), repo).get_profiles(["AAPL", "ZZZZ"])

    assert finnhub.calls == ["AAPL"]


def test_lookups_per_request_are_capped_and_the_rest_are_pending() -> None:
    finnhub = FakeProvider(FINNHUB)
    repo = FakeMarketRepository()
    old = (NOW - timedelta(days=40)).replace(tzinfo=None)
    repo.stored_profiles["SHOP"] = StoredProfile(
        "SHOP", "Shopify", "Information Technology", None, "yfinance", old
    )
    symbols = ["AAPL", "NVDA", "ODD", "SHOP", "VOO"]

    result = make_service(
        finnhub, FakeProvider(YAHOO), repo, max_lookups=2
    ).get_profiles(symbols)

    assert finnhub.calls == ["AAPL", "NVDA"]
    # Past the budget: a stale profile still serves, a missing one is pending.
    assert result.profiles["SHOP"].sector == "Information Technology"
    assert result.pending == ["ODD", "VOO"]


def test_an_outage_is_not_cached_as_unknown() -> None:
    repo = FakeMarketRepository()

    result = make_service(
        FakeProvider({}, down=True), FakeProvider({}, down=True), repo
    ).get_profiles(["AAPL"])

    assert result.profiles["AAPL"].sector is None
    assert repo.stored_profiles == {}


def test_works_without_a_database() -> None:
    service = ProfileService(
        FakeProvider(FINNHUB), FakeProvider(YAHOO), lambda: None, clock=lambda: NOW
    )

    assert service.get_profiles(["NVDA"]).profiles["NVDA"].sector == (
        "Information Technology"
    )


class StubService:
    def get_profiles(self, symbols: list[str]) -> ProfilesResponse:
        return ProfilesResponse(
            profiles={
                s: CompanyProfile(ticker=s, sector=FUNDS, source="yfinance")
                for s in symbols
            }
        )


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_profile_service] = lambda: StubService()
    yield TestClient(app, headers=INTERNAL_HEADERS)
    app.dependency_overrides.clear()


def test_profiles_route(client: TestClient) -> None:
    res = client.get("/profiles", params={"symbols": "voo,spy"})

    assert res.status_code == 200
    assert set(res.json()["profiles"]) == {"VOO", "SPY"}
    assert res.json()["pending"] == []


def test_profiles_route_rejects_empty_symbols(client: TestClient) -> None:
    assert client.get("/profiles", params={"symbols": ","}).status_code == 422
