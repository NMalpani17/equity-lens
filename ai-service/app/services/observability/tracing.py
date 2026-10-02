"""Optional Langfuse tracing for chat turns (and eval runs).

Tracing is off unless both Langfuse keys are configured; then nothing from
the SDK is even imported. When on, each turn gets a LangChain callback
handler, so agent steps, tool calls (with latency), model calls (with token
usage and cost) and errors become one trace. User ids are hashed and every
payload passes through :class:`~.masking.TraceMasker` before export.

Tracing must never break or slow a chat turn: spans are exported in a
background thread with a short timeout, every call into the SDK here is
guarded, and LangChain logs (rather than raises) callback errors.
"""

import hashlib
import hmac
import logging
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import AbstractContextManager, contextmanager, nullcontext
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Literal, Protocol

from app.config import Settings, get_settings

from .masking import TraceMasker

logger = logging.getLogger(__name__)

ScoreType = Literal["NUMERIC", "CATEGORICAL", "BOOLEAN"]


def hash_user_id(user_id: str, salt: str = "") -> str:
    """A stable pseudonymous id: HMAC-SHA256 with the salt, or plain SHA-256."""
    data = user_id.encode()
    digest = (
        hmac.new(salt.encode(), data, hashlib.sha256).hexdigest()
        if salt
        else hashlib.sha256(data).hexdigest()
    )
    return f"u_{digest[:24]}"


@dataclass
class TurnTrace:
    """Tracing for one run: LangChain config to merge, and the trace id after.

    ``scope`` must wrap the whole agent run in the task that drives it: it
    puts the trace attributes (hashed user, session, tags) into the context
    that every span of the run is created from, so each model call is
    attributed to the user and session, not just the root.
    """

    config: dict[str, Any] = field(default_factory=dict)
    handler: Any = None
    scope: Callable[[], AbstractContextManager[Any]] = nullcontext

    @property
    def trace_id(self) -> str | None:
        return getattr(self.handler, "last_trace_id", None)


class Tracer(Protocol):
    enabled: bool

    def start_turn(
        self,
        *,
        user_id: str,
        session_id: str | None,
        name: str = "chat-turn",
        tags: Sequence[str] = (),
        metadata: dict[str, str] | None = None,
    ) -> TurnTrace: ...

    def record_event(
        self,
        *,
        user_id: str,
        session_id: str | None,
        name: str,
        input: Any,
        output: Any,
        tags: Sequence[str] = (),
        metadata: dict[str, str] | None = None,
    ) -> str | None: ...

    def score(
        self,
        *,
        trace_id: str | None,
        name: str,
        value: float | str,
        data_type: ScoreType | None = None,
        comment: str | None = None,
    ) -> None: ...

    def flush(self) -> None: ...

    def shutdown(self) -> None: ...


class NoopTracer:
    """Used when tracing is not configured (or failed to start)."""

    enabled = False

    def start_turn(self, **_: Any) -> TurnTrace:
        return TurnTrace()

    def record_event(self, **_: Any) -> str | None:
        return None

    def score(self, **_: Any) -> None:
        return None

    def flush(self) -> None:
        return None

    def shutdown(self) -> None:
        return None


@contextmanager
def _propagated(**attributes: Any) -> Iterator[None]:
    """Langfuse ``propagate_attributes``, but never failing the run."""
    manager = None
    try:
        from langfuse import propagate_attributes

        manager = propagate_attributes(**attributes)
        manager.__enter__()
    except Exception:
        logger.warning("could not propagate trace attributes", exc_info=True)
        manager = None
    try:
        yield
    finally:
        if manager is not None:
            try:
                manager.__exit__(None, None, None)
            except Exception:
                logger.warning("could not reset trace attributes", exc_info=True)


class LangfuseTracer:
    """Wraps a Langfuse client; every method swallows and logs SDK errors."""

    enabled = True

    def __init__(self, client: Any, *, public_key: str, user_salt: str = "") -> None:
        self._client = client
        self._public_key = public_key
        self._salt = user_salt

    def _trace_metadata(
        self,
        *,
        user_id: str,
        session_id: str | None,
        name: str,
        tags: Sequence[str],
        metadata: dict[str, str] | None,
    ) -> dict[str, Any]:
        meta: dict[str, Any] = {
            **(metadata or {}),
            "langfuse_user_id": hash_user_id(user_id, self._salt),
            "langfuse_trace_name": name,
            "langfuse_tags": list(tags),
        }
        if session_id:
            meta["langfuse_session_id"] = session_id
        return meta

    def start_turn(
        self,
        *,
        user_id: str,
        session_id: str | None,
        name: str = "chat-turn",
        tags: Sequence[str] = (),
        metadata: dict[str, str] | None = None,
    ) -> TurnTrace:
        try:
            from langfuse.langchain import CallbackHandler

            handler = CallbackHandler(public_key=self._public_key)
        except Exception:
            logger.warning("tracing unavailable for this turn", exc_info=True)
            return TurnTrace()
        meta = self._trace_metadata(
            user_id=user_id,
            session_id=session_id,
            name=name,
            tags=tags,
            metadata=metadata,
        )
        attributes = {
            "user_id": meta["langfuse_user_id"],
            "session_id": session_id,
            "tags": list(tags),
            "trace_name": name,
            "metadata": metadata,
        }
        return TurnTrace(
            config={"callbacks": [handler], "metadata": meta},
            handler=handler,
            scope=lambda: _propagated(**attributes),
        )

    def record_event(
        self,
        *,
        user_id: str,
        session_id: str | None,
        name: str,
        input: Any,
        output: Any,
        tags: Sequence[str] = (),
        metadata: dict[str, str] | None = None,
    ) -> str | None:
        """A single-span trace for turns that never reach the agent."""
        try:
            from langfuse import propagate_attributes

            with propagate_attributes(
                user_id=hash_user_id(user_id, self._salt),
                session_id=session_id,
                trace_name=name,
                tags=list(tags),
                metadata=metadata,
            ):
                span = self._client.start_observation(
                    name=name, as_type="span", input=input, output=output
                )
                span.end()
                return span.trace_id
        except Exception:
            logger.warning("could not record trace event", exc_info=True)
            return None

    def score(
        self,
        *,
        trace_id: str | None,
        name: str,
        value: float | str,
        data_type: ScoreType | None = None,
        comment: str | None = None,
    ) -> None:
        if not trace_id:
            return
        try:
            self._client.create_score(
                name=name,
                value=value,
                trace_id=trace_id,
                data_type=data_type,
                comment=comment,
            )
        except Exception:
            logger.warning("could not record score %s", name, exc_info=True)

    def flush(self) -> None:
        try:
            self._client.flush()
        except Exception:
            logger.warning("tracing flush failed", exc_info=True)

    def shutdown(self, timeout: float = 3.0) -> None:
        """Flush and stop, waiting at most ``timeout`` seconds.

        With Langfuse down, score uploads keep retrying for several seconds;
        the flush runs in a daemon thread so it can't hold up process exit.
        """

        def close() -> None:
            try:
                self._client.shutdown()
            except Exception:
                logger.warning("tracing shutdown failed", exc_info=True)

        worker = threading.Thread(target=close, name="langfuse-shutdown", daemon=True)
        worker.start()
        worker.join(timeout)
        if worker.is_alive():
            logger.warning("tracing shutdown timed out; unsent spans dropped")


def _secrets(settings: Settings) -> list[str]:
    """Credential values the masker removes verbatim from any trace payload."""
    return [
        settings.internal_token,
        settings.gemini_api_key,
        settings.pinecone_api_key,
        settings.equibles_api_key,
        settings.finnhub_api_key,
        settings.langfuse_secret_key,
        settings.database_url,
    ]


# OpenTelemetry scopes whose spans Langfuse must not export. FastMCP traces
# every tool call itself; those spans have no exported parent (so they show
# up as orphan traces with no user), duplicate our LangChain tool spans, and
# bypass the mask hook, which only covers Langfuse's own observations.
BLOCKED_INSTRUMENTATION_SCOPES = frozenset({"fastmcp"})


def _should_export_span(span: Any) -> bool:
    """Langfuse's default export rule, minus the blocked scopes."""
    from langfuse.span_filter import is_default_export_span

    scope = span.instrumentation_scope
    blocked = scope is not None and scope.name in BLOCKED_INSTRUMENTATION_SCOPES
    return not blocked and is_default_export_span(span)


def build_tracer(
    settings: Settings, *, span_exporter: Any = None, tracer_provider: Any = None
) -> Tracer:
    """A Langfuse tracer when both keys are set, otherwise a no-op tracer.

    ``span_exporter`` replaces the OTLP exporter and ``tracer_provider`` the
    OpenTelemetry provider (tests capture spans with them).
    """
    if not settings.tracing_enabled:
        return NoopTracer()
    try:
        from langfuse import Langfuse

        client = Langfuse(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            base_url=settings.langfuse_base_url,
            environment=settings.environment,
            sample_rate=settings.langfuse_sample_rate,
            timeout=settings.langfuse_timeout_seconds,
            flush_interval=settings.langfuse_flush_interval_seconds,
            mask=TraceMasker(_secrets(settings)),
            should_export_span=_should_export_span,
            **({"span_exporter": span_exporter} if span_exporter else {}),
            **({"tracer_provider": tracer_provider} if tracer_provider else {}),
        )
    except Exception:
        logger.warning(
            "Langfuse tracing disabled: client failed to start", exc_info=True
        )
        return NoopTracer()
    logger.info("Langfuse tracing enabled")
    return LangfuseTracer(
        client,
        public_key=settings.langfuse_public_key,
        user_salt=settings.trace_user_salt,
    )


@lru_cache
def get_tracer() -> Tracer:
    return build_tracer(get_settings())


def shutdown_tracer() -> None:
    """Flush pending spans at shutdown (only if a tracer was ever built)."""
    if get_tracer.cache_info().currsize:
        get_tracer().shutdown()
