"""Tracing: optional, pseudonymous, masked, and never able to break a turn."""

import asyncio
import json
import logging
import time
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from app.config import Settings
from app.models.chat import ChatTurnRequest
from app.services.chat import mcp_server
from app.services.chat.agent import ChatService
from app.services.chat.context import turn_registry
from app.services.chat.tools import ToolDeps
from app.services.observability import tracing
from app.services.observability.masking import TraceMasker
from app.services.observability.tracing import (
    LangfuseTracer,
    NoopTracer,
    TurnTrace,
    build_tracer,
    hash_user_id,
)
from tests.chat_fakes import ScriptedChatModel, ai, portfolio, position

USER_ID = "3f2b8c1e-7d4a-4b9e-9c1d-2a6f5e8b7c90"


def settings(**overrides) -> Settings:
    values = {"internal_token": "t", "gemini_api_key": "k", **overrides}
    return Settings(_env_file=None, **values)


@pytest.fixture(autouse=True)
def tool_deps():
    deps = ToolDeps(
        search=MagicMock, market=MagicMock, history=MagicMock, resolver=MagicMock
    )
    mcp_server.set_tool_deps(lambda: deps)
    yield
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


def run_turn(service: ChatService, message: str, **kwargs) -> list:
    request = ChatTurnRequest(
        user_id=USER_ID, conversation_id="conv-1", message=message, **kwargs
    )

    async def collect():
        return [e async for e in service.stream_turn(request)]

    return asyncio.run(collect())


def make_service(model, tracer) -> ChatService:
    return ChatService(
        settings(),
        lambda: model,
        mcp_server.mcp,
        turn_registry,
        today=lambda _tz: date(2026, 10, 1),
        tracer=tracer,
    )


# --- configuration --------------------------------------------------------------


def test_hashed_user_ids_are_stable_salted_and_never_raw() -> None:
    plain = hash_user_id(USER_ID)
    salted = hash_user_id(USER_ID, "pepper")

    assert plain == hash_user_id(USER_ID) and plain.startswith("u_")
    assert salted != plain and USER_ID not in plain + salted


@pytest.mark.parametrize(
    "keys",
    [{}, {"langfuse_public_key": "pk-lf-1"}, {"langfuse_secret_key": "sk-lf-1"}],
)
def test_tracing_is_disabled_without_both_keys(keys) -> None:
    with patch("langfuse.Langfuse") as client:
        tracer = build_tracer(settings(**keys))

    assert isinstance(tracer, NoopTracer) and tracer.enabled is False
    client.assert_not_called()
    assert tracer.start_turn(user_id="u", session_id=None).config == {}


def test_client_start_failure_disables_tracing(caplog) -> None:
    with (
        patch("langfuse.Langfuse", side_effect=RuntimeError("bad host")),
        caplog.at_level(logging.WARNING),
    ):
        tracer = build_tracer(
            settings(langfuse_public_key="pk-lf-x", langfuse_secret_key="sk-lf-x")
        )

    assert isinstance(tracer, NoopTracer)
    assert "tracing disabled" in caplog.text


def test_client_gets_short_timeout_and_a_masker_with_the_secrets() -> None:
    with patch("langfuse.Langfuse") as client:
        tracer = build_tracer(
            settings(
                langfuse_public_key="pk-lf-x",
                langfuse_secret_key="sk-lf-secret",
                langfuse_base_url="https://lf.example",
                pinecone_api_key="pcsk-secret-key",
            )
        )

    assert isinstance(tracer, LangfuseTracer)
    kwargs = client.call_args.kwargs
    assert kwargs["timeout"] == 2 and kwargs["base_url"] == "https://lf.example"
    mask = kwargs["mask"]
    assert isinstance(mask, TraceMasker)
    assert "pcsk-secret-key" not in mask(data="key=pcsk-secret-key sk-lf-secret")
    assert "sk-lf-secret" not in mask(data="sk-lf-secret")


def test_turn_config_carries_pseudonymous_trace_attributes() -> None:
    tracer = LangfuseTracer(MagicMock(), public_key="pk", user_salt="pepper")

    trace = tracer.start_turn(
        user_id=USER_ID,
        session_id="conv-1",
        tags=["chat", "eval"],
        metadata={"model": "m"},
    )

    meta = trace.config["metadata"]
    assert meta["langfuse_user_id"] == hash_user_id(USER_ID, "pepper")
    assert meta["langfuse_session_id"] == "conv-1"
    assert meta["langfuse_tags"] == ["chat", "eval"] and meta["model"] == "m"
    assert len(trace.config["callbacks"]) == 1
    assert USER_ID not in json.dumps(meta)


def test_sdk_errors_are_swallowed() -> None:
    client = MagicMock()
    client.create_score.side_effect = RuntimeError("down")
    client.flush.side_effect = RuntimeError("down")
    client.shutdown.side_effect = RuntimeError("down")
    client.start_observation.side_effect = RuntimeError("down")
    tracer = LangfuseTracer(client, public_key="pk")

    tracer.score(trace_id="t", name="x", value=1)
    tracer.flush()
    tracer.shutdown()
    assert (
        tracer.record_event(
            user_id="u", session_id=None, name="n", input="i", output="o"
        )
        is None
    )
    with patch("langfuse.langchain.CallbackHandler", side_effect=RuntimeError):
        assert tracer.start_turn(user_id="u", session_id=None).config == {}


def test_shutdown_tracer_does_not_build_one(monkeypatch) -> None:
    tracing.get_tracer.cache_clear()
    built = MagicMock()
    monkeypatch.setattr(tracing, "build_tracer", built)

    tracing.shutdown_tracer()

    built.assert_not_called()


# --- chat turns -------------------------------------------------------------------


class RecordingTracer(NoopTracer):
    """Hands out given callbacks and records scores and events."""

    enabled = True

    def __init__(self, callbacks: list | None = None) -> None:
        self.callbacks = callbacks or []
        self.scores: list[dict] = []
        self.events: list[dict] = []
        self.turns: list[dict] = []

    def start_turn(self, **kwargs: Any) -> TurnTrace:
        self.turns.append(kwargs)
        handler = MagicMock(last_trace_id="trace-1")
        return TurnTrace(config={"callbacks": self.callbacks}, handler=handler)

    def record_event(self, **kwargs: Any) -> str | None:
        self.events.append(kwargs)
        return "trace-guard"

    def score(self, **kwargs: Any) -> None:
        self.scores.append(kwargs)


class ExplodingHandler(BaseCallbackHandler):
    """A tracing backend that fails on every callback."""

    def __getattribute__(self, name: str) -> Any:
        if name.startswith("on_"):

            def boom(*_: Any, **__: Any) -> None:
                raise RuntimeError("tracing backend exploded")

            return boom
        return super().__getattribute__(name)


def test_a_failing_tracing_handler_never_breaks_the_turn() -> None:
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}]),
            ai("You hold NVDA."),
        ]
    )
    tracer = RecordingTracer([ExplodingHandler()])

    events = run_turn(
        make_service(model, tracer),
        "How is my portfolio?",
        portfolio=portfolio(position("NVDA", 10, 100, 150)),
    )

    done = events[-1].data
    assert done["status"] == "complete" and done["content"] == "You hold NVDA."
    assert done["trace_id"] == "trace-1"
    assert tracer.scores == [
        {
            "trace_id": "trace-1",
            "name": "turn_status",
            "value": "complete",
            "data_type": "CATEGORICAL",
        }
    ]
    assert tracer.turns[0]["session_id"] == "conv-1"
    assert tracer.turns[0]["tags"] == ["chat"]


def test_failed_turns_are_scored_as_errors() -> None:
    model = ScriptedChatModel(script=[], error=RuntimeError("provider down"))
    tracer = RecordingTracer()

    events = run_turn(make_service(model, tracer), "What did NVDA say?")

    assert events[-1].type == "error"
    assert tracer.scores[0]["value"] == "error"


def test_guardrail_refusals_are_traced_without_the_agent() -> None:
    model = ScriptedChatModel(script=[])
    tracer = RecordingTracer()

    events = run_turn(make_service(model, tracer), "Give me a banana bread recipe")

    assert events[-1].data["status"] == "refused"
    assert tracer.turns == [] and tracer.events[0]["tags"] == ["chat", "guardrail"]
    assert tracer.scores[0] == {
        "trace_id": "trace-guard",
        "name": "turn_status",
        "value": "refused",
        "data_type": "CATEGORICAL",
    }


# --- end to end with the real SDK (no network) -----------------------------------


def real_tracer(public_key: str, exporter=None, **overrides) -> LangfuseTracer:
    tracer = build_tracer(
        settings(
            langfuse_public_key=public_key,
            langfuse_secret_key="sk-lf-test-secret",
            # Nothing listens here: the "Langfuse is down" case.
            langfuse_base_url="http://127.0.0.1:9",
            langfuse_timeout_seconds=1,
            **overrides,
        ),
        span_exporter=exporter,
    )
    assert isinstance(tracer, LangfuseTracer)
    return tracer


def test_exported_spans_are_masked_and_pseudonymous() -> None:
    exporter = InMemorySpanExporter()
    tracer = real_tracer(
        "pk-lf-mask-test", exporter, internal_token="t-internal-secret"
    )
    snapshot = portfolio(position("NVDA", 75, 164.6, 182.4))  # worth $13,680
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}]),
            ai("Your NVDA position is worth $13,680.00. Email jane@example.com."),
        ]
    )

    # Scores go to the (unreachable) API; only spans are under test here.
    tracer.score = lambda **_: None  # type: ignore[method-assign]

    events = run_turn(
        make_service(model, tracer), "How is my portfolio?", portfolio=snapshot
    )
    tracer.flush()

    assert events[-1].data["status"] == "complete"
    spans = exporter.get_finished_spans()
    assert spans, "expected spans for the turn"
    exported = json.dumps([dict(s.attributes or {}) for s in spans], default=str)
    assert "get_portfolio" in exported  # the tool call is traced
    assert hash_user_id(USER_ID) in exported and USER_ID not in exported
    for leaked in ("13,680", "13680", "12345", "jane@example.com", "t-internal-secret"):
        assert leaked not in exported, leaked
    tracer.shutdown()


def test_every_model_call_carries_the_hashed_user_and_session() -> None:
    # Langfuse attributes cost per user/session from the generation spans, so
    # the root span alone isn't enough.
    exporter = InMemorySpanExporter()
    tracer = real_tracer("pk-lf-attribution-test", exporter)
    tracer.score = lambda **_: None  # type: ignore[method-assign]
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}]),
            ai("You hold NVDA."),
        ]
    )

    events = run_turn(
        make_service(model, tracer),
        "How is my portfolio?",
        portfolio=portfolio(position("NVDA", 10, 100, 150)),
    )
    tracer.flush()

    assert events[-1].data["status"] == "complete"
    spans = [dict(s.attributes or {}) for s in exporter.get_finished_spans()]
    generations = [
        s for s in spans if s.get("langfuse.observation.type") == "generation"
    ]
    tools = [s for s in spans if s.get("langfuse.observation.type") == "tool"]
    assert len(generations) == 2 and tools
    for span in generations + tools:
        assert span.get("user.id") == hash_user_id(USER_ID)
        assert span.get("session.id") == "conv-1"
    tracer.shutdown()


def test_fastmcp_spans_are_never_exported(monkeypatch) -> None:
    import fastmcp.telemetry as fastmcp_telemetry
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor

    provider = TracerProvider()
    everything = InMemorySpanExporter()  # what the app emits, before filtering
    provider.add_span_processor(SimpleSpanProcessor(everything))
    # Point FastMCP's real instrumentation at this test's provider.
    monkeypatch.setattr(
        fastmcp_telemetry,
        "otel_get_tracer",
        lambda name, version=None: provider.get_tracer(name, version),
    )
    exported = InMemorySpanExporter()
    tracer = build_tracer(
        settings(
            langfuse_public_key="pk-lf-scope-test",
            langfuse_secret_key="sk-lf-test-secret",
            langfuse_base_url="http://127.0.0.1:9",
            langfuse_timeout_seconds=1,
        ),
        span_exporter=exported,
        tracer_provider=provider,
    )
    assert isinstance(tracer, LangfuseTracer)
    tracer.score = lambda **_: None  # type: ignore[method-assign]
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[{"name": "get_portfolio", "id": "p1"}]),
            ai("You hold NVDA."),
        ]
    )

    run_turn(
        make_service(model, tracer),
        "How is my portfolio?",
        portfolio=portfolio(position("NVDA", 10, 100, 150)),
    )
    tracer.flush()

    emitted = {s.instrumentation_scope.name for s in everything.get_finished_spans()}
    assert "fastmcp" in emitted  # FastMCP did trace the tool call...
    spans = exported.get_finished_spans()
    assert {s.instrumentation_scope.name for s in spans} == {"langfuse-sdk"}
    tools = [
        s for s in spans if s.attributes.get("langfuse.observation.type") == "tool"
    ]
    assert [s.name for s in tools] == ["get_portfolio"]  # ...ours is the only copy
    tracer.shutdown()


def test_a_failing_trace_scope_never_breaks_the_turn() -> None:
    class BrokenScope:
        def __enter__(self):
            raise RuntimeError("context propagation failed")

        def __exit__(self, *_: Any) -> None:
            return None

    class ScopedTracer(RecordingTracer):
        def start_turn(self, **kwargs: Any) -> TurnTrace:
            trace = super().start_turn(**kwargs)
            trace.scope = tracing._propagated  # real wrapper, broken SDK below
            return trace

    model = ScriptedChatModel(script=[ai("NVDA reports in November.")])
    with patch("langfuse.propagate_attributes", return_value=BrokenScope()):
        events = run_turn(make_service(model, ScopedTracer()), "When does NVDA report?")

    assert events[-1].data["content"] == "NVDA reports in November."


def test_position_math_the_model_repeats_is_masked_in_exported_spans() -> None:
    exporter = InMemorySpanExporter()
    tracer = real_tracer("pk-lf-math-test", exporter)
    tracer.score = lambda **_: None  # type: ignore[method-assign]
    snapshot = portfolio(position("NVDA", 40, 95.5, 182))
    model = ScriptedChatModel(
        script=[
            ai(
                tool_calls=[
                    {
                        "name": "calculate_position",
                        "args": {
                            "action": "buy",
                            "shares": 10,
                            "price": 180,
                            "ticker": "NVDA",
                        },
                        "id": "m1",
                    }
                ]
            ),
            ai("Your new average cost would be $112.40 (cost basis $5,620.00)."),
        ]
    )

    events = run_turn(
        make_service(model, tracer), "If I buy 10 NVDA at $180?", portfolio=snapshot
    )
    tracer.flush()

    assert "$112.40" in events[-1].data["content"]  # the user still sees it
    exported = json.dumps(
        [dict(s.attributes or {}) for s in exporter.get_finished_spans()], default=str
    )
    assert "calculate_position" in exported
    for leaked in ("112.4", "5,620", "5620"):
        assert leaked not in exported, leaked
    tracer.shutdown()


def test_an_unreachable_langfuse_does_not_slow_the_turn() -> None:
    tracer = real_tracer("pk-lf-down-test")
    model = ScriptedChatModel(script=[ai("NVDA reports in November.")])

    started = time.perf_counter()
    events = run_turn(make_service(model, tracer), "When does NVDA report?")
    elapsed = time.perf_counter() - started

    assert events[-1].data["content"] == "NVDA reports in November."
    assert elapsed < 2.0, f"turn took {elapsed:.2f}s with Langfuse down"
    # Shutdown (at process exit, never in a turn) is bounded too.
    started = time.perf_counter()
    tracer.shutdown(timeout=1.0)
    assert time.perf_counter() - started < 1.5
