"""Route tests for /chat/stream (internal auth, validation, SSE framing)."""

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services.chat.agent import ChatEvent
from app.services.chat.service import get_chat_service
from tests.conftest import TEST_INTERNAL_TOKEN as TOKEN

HEADERS = {"X-Internal-Token": TOKEN}
BODY = {"user_id": "user-1", "message": "What did NVDA say about demand?"}


class FakeChatService:
    def __init__(self) -> None:
        self.requests = []

    async def stream_turn(self, request):
        self.requests.append(request)
        yield ChatEvent(
            "tool_start",
            {
                "id": "c1",
                "name": "search_transcripts",
                "label": "Searching NVDA transcripts…",
                "args": {},
            },
        )
        yield ChatEvent(
            "tool_end",
            {
                "id": "c1",
                "name": "search_transcripts",
                "ok": True,
                "summary": "Found 2 passages",
            },
        )
        yield ChatEvent("token", {"text": "Demand is strong "})
        yield ChatEvent("token", {"text": "[1]."})
        yield ChatEvent(
            "done",
            {
                "content": "Demand is strong [1].",
                "status": "complete",
                "citations": [],
                "tool_calls": [],
                "usage": {},
                "model": "fake",
            },
        )


@pytest.fixture
def service(monkeypatch) -> Iterator[FakeChatService]:
    monkeypatch.setattr(get_settings(), "internal_token", TOKEN)
    fake = FakeChatService()
    app.dependency_overrides[get_chat_service] = lambda: fake
    yield fake
    app.dependency_overrides.clear()


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for frame in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_streams_events_as_sse(service) -> None:
    with TestClient(app) as client:
        res = client.post("/chat/stream", json=BODY, headers=HEADERS)

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(res.text)
    assert [e for e, _ in events] == [
        "tool_start",
        "tool_end",
        "token",
        "token",
        "done",
    ]
    assert events[0][1]["label"] == "Searching NVDA transcripts…"
    assert events[-1][1]["content"] == "Demand is strong [1]."
    assert service.requests[0].user_id == "user-1"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}])
def test_requires_the_internal_token(service, headers) -> None:
    with TestClient(app) as client:
        res = client.post("/chat/stream", json=BODY, headers=headers)

    assert res.status_code == 401
    assert res.json()["error"] == "unauthorized"
    assert service.requests == []


def test_auth_is_checked_before_body_validation(service) -> None:
    with TestClient(app) as client:
        res = client.post("/chat/stream", json={"nonsense": True})

    assert res.status_code == 401


def test_message_length_is_capped(service) -> None:
    long_message = "x" * (get_settings().chat_max_message_chars + 1)

    with TestClient(app) as client:
        res = client.post(
            "/chat/stream", json={**BODY, "message": long_message}, headers=HEADERS
        )

    assert res.status_code == 422
    assert res.json()["error"] == "message_too_long"
    assert service.requests == []


@pytest.mark.parametrize(
    "body",
    [
        {"message": "hi"},  # no user id
        {"user_id": "u", "message": "   "},
        {
            "user_id": "u",
            "message": "hi",
            "history": [{"role": "system", "content": "x"}],
        },
    ],
)
def test_invalid_bodies_are_rejected(service, body) -> None:
    with TestClient(app) as client:
        res = client.post("/chat/stream", json=body, headers=HEADERS)

    assert res.status_code == 422


def test_unconfigured_token_returns_503(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "internal_token", "")

    with TestClient(app) as client:
        res = client.post("/chat/stream", json=BODY, headers=HEADERS)

    assert res.status_code == 503
    assert res.json()["error"] == "chat_not_configured"
