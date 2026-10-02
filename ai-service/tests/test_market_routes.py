"""Tests for the market-data routes using a stubbed service."""

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.quote import Quote, QuotesResponse
from app.services.market_data.base import (
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from app.services.market_data.service import get_market_data_service
from tests.conftest import INTERNAL_HEADERS


class StubService:
    def get_quote(self, ticker: str) -> Quote:
        if ticker.upper() == "NOPE":
            raise QuoteNotFoundError("unknown")
        if ticker.upper() == "DOWN":
            raise ProviderUnavailableError("down")
        return Quote.build(
            ticker=ticker,
            price=150.0,
            previous_close=148.0,
            provider="finnhub",
            as_of=datetime.now(UTC),
        )

    def get_quotes(self, tickers: list[str]) -> QuotesResponse:
        response = QuotesResponse()
        for ticker in tickers:
            try:
                response.quotes[ticker.upper()] = self.get_quote(ticker)
            except QuoteNotFoundError:
                response.errors[ticker.upper()] = "not_found"
        return response


@pytest.fixture
def client() -> Iterator[TestClient]:
    app.dependency_overrides[get_market_data_service] = lambda: StubService()
    yield TestClient(app, headers=INTERNAL_HEADERS)
    app.dependency_overrides.clear()


def test_get_single_quote_ok(client: TestClient) -> None:
    res = client.get("/quotes/AAPL")

    assert res.status_code == 200
    assert res.json()["ticker"] == "AAPL"


def test_get_single_quote_not_found(client: TestClient) -> None:
    res = client.get("/quotes/NOPE")

    assert res.status_code == 404


def test_get_single_quote_unavailable(client: TestClient) -> None:
    res = client.get("/quotes/DOWN")

    assert res.status_code == 502


def test_batch_quotes_split_success_and_errors(client: TestClient) -> None:
    res = client.get("/quotes", params={"symbols": "AAPL,NOPE,aapl"})

    assert res.status_code == 200
    body = res.json()
    assert "AAPL" in body["quotes"]
    assert body["errors"]["NOPE"] == "not_found"


def test_batch_quotes_rejects_empty(client: TestClient) -> None:
    res = client.get("/quotes", params={"symbols": " , "})

    assert res.status_code == 422
