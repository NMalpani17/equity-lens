"""Tests for the daily-closes route using a stubbed service."""

from collections.abc import Iterator
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.daily_closes import DailyClosesResponse
from app.models.price_history import PricePoint
from app.services.market_data.daily_closes import get_daily_closes_service
from tests.conftest import INTERNAL_HEADERS


class StubService:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], date]] = []

    def get_closes(self, symbols: list[str], start: date) -> DailyClosesResponse:
        self.calls.append((symbols, start))
        return DailyClosesResponse(
            series={"AAPL": [PricePoint(date=start, close=100.0)]},
            errors={"ZZZZ": "not_found"},
            through=date(2026, 10, 16),
        )


@pytest.fixture
def stub() -> Iterator[StubService]:
    service = StubService()
    app.dependency_overrides[get_daily_closes_service] = lambda: service
    yield service
    app.dependency_overrides.clear()


def test_returns_series_and_errors(stub: StubService) -> None:
    client = TestClient(app, headers=INTERNAL_HEADERS)

    res = client.get(
        "/history/daily", params={"symbols": "aapl, zzzz,AAPL", "start": "2026-10-01"}
    )

    assert res.status_code == 200
    assert stub.calls == [(["AAPL", "ZZZZ"], date(2026, 10, 1))]
    body = res.json()
    assert body["series"]["AAPL"][0] == {"date": "2026-10-01", "close": 100.0}
    assert body["errors"] == {"ZZZZ": "not_found"}


@pytest.mark.parametrize(
    "params",
    [
        {"symbols": " , ", "start": "2026-10-01"},
        {"symbols": "AAPL", "start": "10/01/2026"},
        {"symbols": "AAPL"},
        {"symbols": ",".join(f"T{i}" for i in range(501)), "start": "2026-10-01"},
    ],
)
def test_rejects_bad_queries(stub: StubService, params: dict[str, str]) -> None:
    res = TestClient(app, headers=INTERNAL_HEADERS).get("/history/daily", params=params)

    assert res.status_code == 422
    assert stub.calls == []


def test_requires_the_internal_token(stub: StubService) -> None:
    res = TestClient(app).get(
        "/history/daily", params={"symbols": "AAPL", "start": "2026-10-01"}
    )

    assert res.status_code == 401
