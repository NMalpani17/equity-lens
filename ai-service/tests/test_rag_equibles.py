"""Tests for the Equibles client using a mocked HTTP transport."""

from collections.abc import Callable

import httpx
import pytest

from app.services.rag.equibles import EquiblesClient
from app.services.rag.errors import (
    EquiblesError,
    EquiblesNotFoundError,
    EquiblesQuotaError,
)
from app.services.rag.retry import RetryPolicy

NO_SLEEP = RetryPolicy(max_attempts=3, base_delay=0, sleep=lambda _: None)


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> EquiblesClient:
    return EquiblesClient(
        "eq_test",
        base_url="https://api.equibles.test/v1",
        timeout=5,
        retry_policy=NO_SLEEP,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def event(fy: int | None, fq: int | None, has_transcript: bool = True) -> dict:
    return {
        "id": f"evt-{fy}-{fq}",
        "title": f"Apple Inc Q{fq} FY{fy} Earnings Call",
        "callDate": "2025-07-31T00:00:00+00:00",
        "fiscalYear": fy,
        "fiscalQuarter": fq,
        "status": "Concluded",
        "hasTranscript": has_transcript,
    }


def test_list_earnings_calls_filters_and_authenticates() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    event(2026, 1, has_transcript=False),  # scheduled, no transcript
                    event(2025, 4),
                    event(None, None),  # non-earnings row without a period
                    event(2025, 3),
                ]
            },
        )

    calls = make_client(handler).list_earnings_calls("AAPL")

    assert [(c.fiscal_year, c.fiscal_quarter) for c in calls] == [(2025, 4), (2025, 3)]
    request = seen[0]
    assert request.url.path == "/v1/stocks/AAPL/investor-events"
    assert request.url.params["eventType"] == "EarningsCall"
    assert request.headers["Authorization"] == "Bearer eq_test"


def test_get_transcript_merges_pages() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        if offset == 0:
            turns = [{"speakerIndex": 1, "text": "a"}, {"speakerIndex": 2, "text": "b"}]
            return httpx.Response(
                200,
                json={
                    "ticker": "AAPL",
                    "fiscalYear": 2025,
                    "fiscalQuarter": 3,
                    "data": turns,
                    "hasMore": True,
                    "offset": 0,
                },
            )
        return httpx.Response(
            200,
            json={
                "ticker": "AAPL",
                "data": [{"speakerIndex": 3, "text": "c"}],
                "hasMore": False,
                "offset": offset,
            },
        )

    payload = make_client(handler).get_transcript("AAPL", 2025, 3)

    assert [t["text"] for t in payload["data"]] == ["a", "b", "c"]
    assert payload["hasMore"] is False
    assert payload["turnCount"] == 3


def test_quota_exhausted_is_not_retried() -> None:
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, json={"error": {"code": "rate_limited"}})

    with pytest.raises(EquiblesQuotaError):
        make_client(handler).list_earnings_calls("AAPL")
    assert calls == 1


def test_server_errors_are_retried_then_succeed() -> None:
    responses = iter([httpx.Response(503), httpx.Response(200, json={"data": []})])

    calls = make_client(lambda _: next(responses)).list_earnings_calls("AAPL")

    assert calls == []


def test_server_errors_give_up_after_max_attempts() -> None:
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(500)

    with pytest.raises(EquiblesError):
        make_client(handler).list_earnings_calls("AAPL")
    assert attempts == NO_SLEEP.max_attempts


def test_not_found_raises_specific_error() -> None:
    with pytest.raises(EquiblesNotFoundError):
        make_client(lambda _: httpx.Response(404)).get_transcript("ZZZZ", 2025, 1)
