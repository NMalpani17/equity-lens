"""The report service and route: claims, saving, failures, cancellation, tracing."""

import asyncio
import contextlib
import json
import threading
from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from app.main import app
from app.models.report import ReportRequest
from app.services.chat import mcp_server
from app.services.chat.context import TurnRegistry
from app.services.observability.tracing import TurnTrace, hash_user_id
from app.services.rag.repository import TickerRecord
from app.services.report.repository import Claim, ClaimOutcome
from app.services.report.service import ReportEvent, ReportService, get_report_service
from tests.chat_fakes import ai
from tests.conftest import INTERNAL_HEADERS
from tests.test_report_graph import (
    DRAFT,
    TRANSCRIPT_KEY,
    USER_KEYS,
    ByPromptModel,
    all_keys,
    install_tool_deps,
    make_agents,
    research_script,
    writer,
)
from tests.test_tracing import real_tracer

USER_ID = "3f2b8c1e-7d4a-4b9e-9c1d-2a6f5e8b7c90"
GENERATED = datetime(2026, 10, 7, 12, 0)


@pytest.fixture
def deps():
    yield install_tool_deps()
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


class FakeRepo:
    """Like the real one: a live claim blocks others until saved or released."""

    def __init__(self, outcome: ClaimOutcome = ClaimOutcome.CLAIMED) -> None:
        self.outcome = outcome
        self.claims: list[tuple] = []
        self.saved: list[dict[str, Any]] = []
        self.released: list[str] = []
        self.save_result: datetime | None = GENERATED
        self.active: str | None = None

    def claim(self, ticker, fiscal_year, fiscal_quarter, **kwargs) -> Claim:
        self.claims.append((ticker, fiscal_year, fiscal_quarter, kwargs))
        if self.outcome is not ClaimOutcome.CLAIMED:
            return Claim(self.outcome)
        if self.active is not None:
            return Claim(ClaimOutcome.IN_PROGRESS)
        self.active = f"gen-{len(self.claims)}"
        return Claim(ClaimOutcome.CLAIMED, self.active)

    def save(self, generation_id: str, **kwargs) -> datetime | None:
        self.saved.append({"generation_id": generation_id, **kwargs})
        if self.save_result is not None and self.active == generation_id:
            self.active = None
        return self.save_result

    def release(self, generation_id: str) -> None:
        self.released.append(generation_id)
        if self.active == generation_id:
            self.active = None


class RecordingTracer:
    enabled = False

    def __init__(self) -> None:
        self.started: list[dict] = []
        self.scores: list[dict] = []

    def start_turn(self, **kwargs: Any) -> TurnTrace:
        self.started.append(kwargs)
        return TurnTrace()

    def score(self, **kwargs: Any) -> None:
        self.scores.append(kwargs)

    def record_event(self, **_: Any) -> None:
        return None

    def flush(self) -> None:
        return None

    def shutdown(self, timeout: float = 3.0) -> None:
        return None


def nvda(**overrides: Any) -> TickerRecord:
    fields: dict[str, Any] = {
        "ticker": "NVDA",
        "status": "indexed",
        "company_name": "Nvidia Corp",
        "chunk_count": 205,
        "quarters": ["FY2027Q2", "FY2027Q1"],
        "indexed_at": datetime(2026, 10, 1),
    }
    return TickerRecord(**{**fields, **overrides})


def service(
    agents,
    repo: FakeRepo,
    *,
    record: TickerRecord | None = None,
    tracer: Any = None,
    registry: TurnRegistry | None = None,
) -> ReportService:
    return ReportService(
        agents.settings,
        agents,
        mcp_server.mcp,
        registry or TurnRegistry(),
        repo=lambda: repo,
        ticker_record=lambda _t: record if record is not None else nvda(),
        tracer=tracer,
        today=lambda: datetime(2026, 10, 7).date(),
    )


def request(**overrides: Any) -> ReportRequest:
    return ReportRequest(**{"user_id": USER_ID, "ticker": "NVDA", **overrides})


def collect(svc: ReportService, req: ReportRequest) -> list[ReportEvent]:
    async def go() -> list[ReportEvent]:
        return [e async for e in svc.stream(req)]

    return asyncio.run(go())


def happy_agents(deps, **cfg: Any):
    return make_agents(deps, ByPromptModel(scripts=research_script()), writer(), **cfg)


def test_a_report_streams_agent_progress_then_saves_and_returns_it(deps) -> None:
    repo, tracer, registry = FakeRepo(), RecordingTracer(), TurnRegistry()
    svc = service(happy_agents(deps), repo, tracer=tracer, registry=registry)

    events = collect(svc, request())

    assert {e.type for e in events[:-1]} == {"agent"}
    finished = [e.data["agent"] for e in events if e.data.get("state") == "done"]
    assert sorted(finished) == ["market", "transcripts", "writer"]
    assert finished[-1] == "writer"
    done = events[-1]
    assert done.type == "done"
    assert (done.data["fiscal_year"], done.data["fiscal_quarter"]) == (2027, 2)
    assert done.data["generated_at"] == "2026-10-07T12:00:00Z"
    assert done.data["usage"]["cost_usd"] > 0
    # Claimed for the latest indexed quarter with the request's window.
    ticker, year, quarter, kwargs = repo.claims[0]
    assert (ticker, year, quarter) == ("NVDA", 2027, 2)
    assert kwargs["regenerate_after"] == timedelta(days=7)
    assert kwargs["stale_after"] == timedelta(minutes=10)
    # Saved once, the same content the client gets, with nothing user-specific.
    (saved,) = repo.saved
    assert saved["generation_id"] == "gen-1" and saved["company_name"] == "Nvidia Corp"
    assert saved["content"] == done.data["report"]
    assert USER_KEYS.isdisjoint(all_keys(saved["content"]))
    assert USER_ID not in json.dumps(saved["content"])
    assert repo.released == []
    # One trace per report, attributed to the requester (hashed by the tracer).
    (started,) = tracer.started
    assert started["name"] == "research-report"
    assert started["user_id"] == USER_ID and started["session_id"] == "gen-1"
    assert started["tags"] == ["report", "NVDA"]
    assert tracer.scores[-1]["value"] == "complete"
    assert registry._turns == {}  # the run's turn context is gone


@pytest.mark.parametrize(
    ("outcome", "code", "retryable"),
    [
        (ClaimOutcome.IN_PROGRESS, "report_in_progress", True),
        (ClaimOutcome.FRESH, "report_fresh", False),
    ],
)
def test_a_busy_or_fresh_report_is_refused_before_any_model_call(
    deps, outcome, code, retryable
) -> None:
    model = ByPromptModel(scripts=research_script())
    repo = FakeRepo(outcome)
    svc = service(make_agents(deps, model, writer()), repo)

    (event,) = collect(svc, request())

    assert event.type == "error" and event.data["code"] == code
    assert event.data["retryable"] is retryable
    assert model.calls == {} and repo.saved == [] and repo.released == []


def test_regenerate_window_is_passed_to_the_claim(deps) -> None:
    repo = FakeRepo(ClaimOutcome.FRESH)
    collect(service(happy_agents(deps), repo), request(regenerate_after_days=0))

    assert repo.claims[0][3]["regenerate_after"] == timedelta(0)


def test_demo_users_and_unindexed_tickers_are_refused(deps) -> None:
    repo = FakeRepo()
    svc = service(happy_agents(deps), repo)

    (demo,) = collect(svc, request(is_anonymous=True))
    assert demo.data["code"] == "demo_not_allowed"

    failed = service(
        happy_agents(deps), repo, record=nvda(status="failed", indexed_at=None)
    )
    (missing,) = collect(failed, request())
    assert missing.data["code"] == "not_indexed"
    assert repo.claims == []


def test_a_failed_generation_releases_the_claim_and_saves_nothing(deps) -> None:
    scripts = research_script(**{TRANSCRIPT_KEY: [ai("## Drivers\n- No ids.")]})
    repo, tracer = FakeRepo(), RecordingTracer()
    agents = make_agents(deps, ByPromptModel(scripts=scripts), writer())

    events = collect(service(agents, repo, tracer=tracer), request())

    assert events[-1].type == "error"
    assert events[-1].data == {
        "code": "research_failed",
        "message": "The transcript research found no citable passages.",
        "retryable": True,
    }
    failed = [e for e in events if e.data.get("state") == "failed"]
    assert failed and failed[0].data["agent"] == "transcripts"
    assert repo.saved == [] and repo.released == ["gen-1"]
    assert tracer.scores[-1]["value"] == "research_failed"


def test_a_lost_claim_is_reported_and_released(deps) -> None:
    repo = FakeRepo()
    repo.save_result = None

    events = collect(service(happy_agents(deps), repo), request())

    assert events[-1].data["code"] == "report_lost_lock"
    assert repo.released == ["gen-1"]


def test_a_generation_finishes_and_saves_after_the_client_leaves(deps) -> None:
    repo, tracer = FakeRepo(), RecordingTracer()
    svc = service(happy_agents(deps), repo, tracer=tracer)

    async def leave_then_wait() -> ReportEvent:
        stream = svc.stream(request())
        event = await stream.__anext__()
        await stream.aclose()  # the client went away
        await svc.wait_for_background()
        return event

    event = asyncio.run(leave_then_wait())

    assert event.type == "agent"
    assert [s["generation_id"] for s in repo.saved] == ["gen-1"]
    assert repo.released == [] and repo.active is None
    assert tracer.scores[-1]["value"] == "complete"


def test_a_shutdown_cancels_running_generations_and_frees_their_claims(deps) -> None:
    repo, tracer = FakeRepo(), RecordingTracer()
    svc = service(slow_agents(deps), repo, tracer=tracer)

    async def start_then_shut_down() -> None:
        stream = svc.stream(request())
        await stream.__anext__()
        await stream.aclose()
        await svc.shutdown(timeout=5)

    asyncio.run(start_then_shut_down())

    assert repo.saved == [] and repo.released == ["gen-1"]
    assert tracer.scores[-1]["value"] == "interrupted"


def test_a_slow_generation_times_out_and_releases_the_claim(deps) -> None:
    async def slow(messages):
        await asyncio.sleep(5)
        return {"raw": ai("x"), "parsed": DRAFT}

    agents = make_agents(
        deps,
        ByPromptModel(scripts=research_script()),
        RunnableLambda(slow),
        report_timeout_seconds=0.5,
    )
    repo = FakeRepo()

    events = collect(service(agents, repo), request())

    assert events[-1].data["code"] == "report_timeout"
    assert repo.released == ["gen-1"]


def test_one_trace_per_report_with_a_span_per_agent_and_a_hashed_user(deps) -> None:
    exporter = InMemorySpanExporter()
    tracer = real_tracer("pk-lf-report-test", exporter)
    tracer.score = lambda **_: None  # type: ignore[method-assign]
    svc = service(happy_agents(deps), FakeRepo(), tracer=tracer)

    events = collect(svc, request())
    tracer.flush()

    assert events[-1].type == "done"
    spans = exporter.get_finished_spans()
    names = [s.name for s in spans]
    for agent in ("transcript_researcher", "market_analyst", "writer"):
        assert names.count(agent) == 1, (agent, names)
    assert "compare_quarters" in names
    assert len({s.context.trace_id for s in spans}) == 1  # one trace
    exported = json.dumps([dict(s.attributes or {}) for s in spans], default=str)
    assert hash_user_id(USER_ID) in exported and USER_ID not in exported
    tracer.shutdown()


def test_the_route_needs_the_internal_token_and_streams_sse(deps) -> None:
    repo = FakeRepo(ClaimOutcome.IN_PROGRESS)
    app.dependency_overrides[get_report_service] = lambda: service(
        happy_agents(deps), repo
    )
    try:
        client = TestClient(app)
        assert (
            client.post(
                "/reports/stream", json={"user_id": "u", "ticker": "NVDA"}
            ).status_code
            == 401
        )
        res = client.post(
            "/reports/stream",
            json={"user_id": "u", "ticker": "nvda"},
            headers=INTERNAL_HEADERS,
        )
    finally:
        app.dependency_overrides.clear()

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert res.text.startswith("event: error\ndata: ")
    assert json.loads(res.text.split("data: ", 1)[1])["code"] == "report_in_progress"


# --- claims are released right away ------------------------------------------


def failing_agents(deps):
    scripts = research_script(**{TRANSCRIPT_KEY: [ai("## Drivers\n- No ids.")]})
    return make_agents(deps, ByPromptModel(scripts=scripts), writer())


def slow_agents(deps):
    async def slow(messages):
        await asyncio.sleep(5)
        return {"raw": ai("x"), "parsed": DRAFT}

    return make_agents(
        deps,
        ByPromptModel(scripts=research_script()),
        RunnableLambda(slow),
        report_timeout_seconds=0.5,
    )


@pytest.mark.parametrize("failure", ["failed", "timed_out"])
def test_the_next_request_generates_at_once_after_a_run_ends_early(
    deps, failure
) -> None:
    repo = FakeRepo()
    if failure == "failed":
        collect(service(failing_agents(deps), repo), request())
    else:
        collect(service(slow_agents(deps), repo), request())

    assert repo.released == ["gen-1"] and repo.active is None
    retry = collect(service(happy_agents(deps), repo), request())

    assert retry[-1].type == "done"  # not report_in_progress
    assert repo.saved[-1]["generation_id"] == "gen-2"


def test_the_claim_is_released_before_the_error_reaches_the_client(deps) -> None:
    repo = FakeRepo()
    svc = service(failing_agents(deps), repo)

    async def released_when_the_error_arrives() -> list[str]:
        async for event in svc.stream(request()):
            if event.type == "error":
                return list(repo.released)
        raise AssertionError("no error event")

    assert asyncio.run(released_when_the_error_arrives()) == ["gen-1"]


def test_a_claim_that_lands_after_the_client_left_is_released(deps) -> None:
    entered, proceed = threading.Event(), threading.Event()

    class SlowClaimRepo(FakeRepo):
        def claim(self, *args, **kwargs) -> Claim:
            entered.set()
            proceed.wait(5)
            return super().claim(*args, **kwargs)

    repo = SlowClaimRepo()
    svc = service(happy_agents(deps), repo)

    async def disconnect_during_the_claim() -> None:
        async def consume() -> None:
            async for _ in svc.stream(request()):
                pass

        task = asyncio.create_task(consume())
        await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        proceed.set()  # the claim commits after the client is gone
        for _ in range(100):
            if repo.released:
                return
            await asyncio.sleep(0.02)

    asyncio.run(disconnect_during_the_claim())

    assert repo.released == ["gen-1"] and repo.active is None
    assert repo.saved == []
