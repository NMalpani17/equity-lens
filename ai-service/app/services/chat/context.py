"""Per-turn context shared between the agent and the MCP tool server.

The chat endpoint registers a :class:`TurnContext` under a random turn id and
the agent's MCP client sends that id as call ``meta``. Tools look the turn up
server-side, so user identity and portfolio data never pass through the model
and are never accepted from tool arguments.
"""

import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.models.chat import PortfolioSnapshot

from .citations import CitationRegistry

TURN_META_KEY = "dev.equitylens/turn"
_MAX_TURN_AGE_SECONDS = 15 * 60


@dataclass
class TurnContext:
    user_id: str
    is_anonymous: bool
    today: date
    portfolio: PortfolioSnapshot | None
    time_zone: str = "UTC"
    turn_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    sources: CitationRegistry = field(default_factory=CitationRegistry)
    created_at: float = field(default_factory=time.monotonic)
    # Set by the agent: forwards live progress labels (e.g. "Indexing
    # Starbucks transcripts…") to the stream. Thread-safe; tools may run in
    # worker threads.
    progress: Callable[[str], None] | None = None

    def report_progress(self, label: str) -> None:
        if self.progress is not None:
            try:
                self.progress(label)
            except Exception:  # progress is best-effort; never fail a tool
                pass


class TurnRegistry:
    """In-process map of live turns (one entry per streaming chat turn)."""

    def __init__(self) -> None:
        self._turns: dict[str, TurnContext] = {}
        self._lock = threading.Lock()

    def register(self, turn: TurnContext) -> None:
        with self._lock:
            self._evict_stale()
            self._turns[turn.turn_id] = turn

    def get(self, turn_id: str | None) -> TurnContext | None:
        if not turn_id:
            return None
        with self._lock:
            return self._turns.get(turn_id)

    def discard(self, turn_id: str) -> None:
        with self._lock:
            self._turns.pop(turn_id, None)

    def _evict_stale(self) -> None:
        cutoff = time.monotonic() - _MAX_TURN_AGE_SECONDS
        for turn_id in [t for t, ctx in self._turns.items() if ctx.created_at < cutoff]:
            del self._turns[turn_id]


turn_registry = TurnRegistry()


def turn_id_from_meta(meta: Any) -> str | None:
    """Extract the turn id from MCP call meta (a dict or model)."""
    if meta is None:
        return None
    if hasattr(meta, "get"):
        value = meta.get(TURN_META_KEY)
    else:
        value = getattr(meta, "model_extra", {}).get(TURN_META_KEY)
    return value if isinstance(value, str) else None
