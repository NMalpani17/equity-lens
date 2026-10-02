"""Masking applied to everything sent to the tracing backend.

Langfuse calls :meth:`TraceMasker.__call__` on every observation's input,
output and metadata before export. It removes:

- **Secrets**: configured credential values verbatim, plus the generic token,
  bearer and auth-header patterns from :mod:`app.redaction`.
- **Contact details**: email addresses and phone numbers in any text.
- **Portfolio values**: holdings fields (shares, cost, value, gain/loss,
  weights, position-math inputs) by key, in dicts and in JSON tool output.
- **The current turn's portfolio numbers in free text** when written as an
  amount (money, a percentage, a decimal or a grouped number), e.g. the model
  writing "your $12,345.67 position", using the values registered for the
  turn with :func:`set_turn_sensitive_values` (the holdings) and
  :func:`add_turn_sensitive_values` (e.g. position-math results).

The masker fails closed: anything it cannot inspect is replaced by a
placeholder, and Langfuse itself drops data whose masking raised.
"""

import contextvars
import dataclasses
import json
import re
import threading
from collections.abc import Iterable
from typing import Any

from pydantic import BaseModel

from app.models.chat import PortfolioSnapshot
from app.redaction import REDACTED, redact

MASKED = "[masked]"

# Portfolio and position-math fields (tool arguments and results).
SENSITIVE_KEYS = frozenset(
    {
        "total_shares",
        "avg_buy_price",
        "cost_basis",
        "market_value",
        "gain_loss",
        "gain_loss_percent",
        "daily_change",
        "daily_change_percent",
        "weight_percent",
        "total_market_value",
        # calculate_position arguments and results
        "shares",
        "current_shares",
        "current_avg_cost",
        "shares_traded",
        "shares_before",
        "shares_after",
        "avg_cost_before",
        "avg_cost_after",
        "cost_basis_after",
        "realized_gain",
        "realized_gain_percent",
        "market_value_after",
        "unrealized_gain_after",
        "unrealized_gain_percent_after",
        # chart payloads
        "marketValue",
        "weightPercent",
        "totalMarketValue",
    }
)
# Keys whose whole value is dropped (identity, never useful in a trace).
_DROP_KEYS = frozenset({"user_id", "email", "authorization", "x-internal-token"})
# Opaque provider blobs (e.g. Gemini thought signatures): useless in a trace.
_OMITTED = "[omitted]"

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# International or US-style phone numbers: +1 (617) 555-0100, 617-555-0100.
_PHONE_RE = re.compile(
    r"(?<![\w.])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w|\.\d)"
)
# "120 shares", "1,250.5 shares" (not "10 million shares" from a transcript).
_SHARE_COUNT_RE = re.compile(r"\b\d[\d,]*(?:\.\d+)?(?=\s+shares?\b)", re.IGNORECASE)
# A standalone amount; digits inside ids, UUIDs or base64 don't count.
_NUMBER_RE = re.compile(r"(?<![\w.\-−/+=])[-−]?\$?\d[\d,]*(?:\.\d+)?%?(?![\w/+=])")
_MAX_DEPTH = 12

# A mutable set per turn: context copies (worker threads, the in-process MCP
# server task) share the same object, so values a tool adds are visible to
# the masking of every later span in the turn.
_turn_values: contextvars.ContextVar[set[float] | None] = contextvars.ContextVar(
    "trace_sensitive_values", default=None
)
_values_lock = threading.Lock()


def _normalize(values: Iterable[float | None]) -> set[float]:
    return {round(abs(v), 2) for v in values if v is not None and abs(v) >= 1}


def portfolio_values(snapshot: PortfolioSnapshot | None) -> frozenset[float]:
    """The numbers in a portfolio that identify the user's holdings.

    Current prices are public and stay visible; tiny values are skipped since
    they would match unrelated numbers in the text.
    """
    if snapshot is None:
        return frozenset()
    values: list[float | None] = []
    for p in snapshot.positions:
        values += [
            p.total_shares,
            p.avg_buy_price,
            p.cost_basis,
            p.market_value,
            p.gain_loss,
            p.gain_loss_percent,
            p.daily_change,
        ]
    t = snapshot.totals
    values += [t.market_value, t.cost_basis, t.gain_loss, t.gain_loss_percent]
    values += [t.daily_change]
    return frozenset(_normalize(values))


def sensitive_numbers(data: Any) -> set[float]:
    """Numbers stored under portfolio/position keys anywhere in ``data``."""
    found: list[float] = []

    def walk(value: Any, depth: int = 0) -> None:
        if depth > _MAX_DEPTH:
            return
        if isinstance(value, dict):
            for key, item in value.items():
                if key in SENSITIVE_KEYS and isinstance(item, int | float):
                    if not isinstance(item, bool):
                        found.append(float(item))
                else:
                    walk(item, depth + 1)
        elif isinstance(value, list | tuple):
            for item in value:
                walk(item, depth + 1)

    walk(data)
    return _normalize(found)


def set_turn_sensitive_values(values: Iterable[float] | None) -> None:
    """Start (or, with ``None``, end) this turn's set of sensitive numbers.

    Uses ``set`` without a reset token on purpose: the chat turn is an async
    generator that may be closed from a different context, where resetting a
    token would raise. Each request runs in its own context copy, so values
    never leak between turns.
    """
    _turn_values.set(None if values is None else _normalize(values))


def add_turn_sensitive_values(values: Iterable[float]) -> None:
    """Add numbers to the current turn's set (no-op outside a traced turn)."""
    current = _turn_values.get()
    if current is None:
        return
    with _values_lock:
        current.update(_normalize(values))


def _turn_snapshot() -> frozenset[float]:
    current = _turn_values.get()
    if not current:
        return frozenset()
    with _values_lock:
        return frozenset(current)


class TraceMasker:
    """Callable passed to ``Langfuse(mask=...)``."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        # Longest first, so a secret containing another is fully replaced.
        self._secrets = sorted(
            {s for s in secrets if s and len(s) >= 6}, key=len, reverse=True
        )

    def __call__(self, *, data: Any, **_: Any) -> Any:
        return self.mask(data)

    def mask(self, data: Any, depth: int = 0) -> Any:
        if depth > _MAX_DEPTH:
            return MASKED
        if data is None or isinstance(data, bool | int | float):
            return data
        if isinstance(data, str):
            return self.mask_text(data)
        if isinstance(data, dict):
            return {
                str(key): self._mask_field(str(key), value, depth)
                for key, value in data.items()
            }
        if isinstance(data, list | tuple | set | frozenset):
            return [self.mask(item, depth + 1) for item in data]
        if isinstance(data, BaseModel):  # LangChain messages, our models
            return self.mask(data.model_dump(mode="json"), depth + 1)
        if dataclasses.is_dataclass(data) and not isinstance(data, type):
            return self.mask(dataclasses.asdict(data), depth + 1)
        return self.mask_text(str(data))

    def _mask_field(self, key: str, value: Any, depth: int) -> Any:
        lowered = key.lower()
        if lowered in _DROP_KEYS:
            return MASKED
        if "signature" in lowered and isinstance(value, str | bytes | list | dict):
            return _OMITTED
        if key in SENSITIVE_KEYS and value is not None:
            return MASKED
        return self.mask(value, depth + 1)

    def mask_text(self, text: str) -> str:
        parsed = _json_container(text)
        if parsed is not None:
            return json.dumps(self.mask(parsed), ensure_ascii=False)
        for secret in self._secrets:
            text = text.replace(secret, REDACTED)
        text = redact(text)
        text = _EMAIL_RE.sub(MASKED, text)
        text = _PHONE_RE.sub(MASKED, text)
        text = _SHARE_COUNT_RE.sub(MASKED, text)
        values = _turn_snapshot()
        if values:
            text = _NUMBER_RE.sub(lambda m: _mask_number(m.group(0), values), text)
        return text


def _json_container(text: str) -> Any:
    """Parse JSON objects/arrays (tool output) so keys can be masked."""
    stripped = text.strip()
    if len(stripped) < 2 or stripped[0] not in "{[":
        return None
    try:
        parsed = json.loads(stripped)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict | list) else None


def _looks_like_an_amount(token: str) -> bool:
    """Money ($), a percentage, a decimal, or a thousands-grouped amount.

    Bare small integers ("6:07 PM", "Q4", "10 analysts") are left alone even
    when they equal a holding's share count; share counts are covered by the
    "N shares" rule instead.
    """
    return any(mark in token for mark in "$%.,")


def _mask_number(token: str, values: frozenset[float]) -> str:
    if not _looks_like_an_amount(token):
        return token
    try:
        number = float(re.sub(r"[^\d.]", "", token))
    except ValueError:
        return token
    if number < 1:
        return token
    if round(number, 2) in values:
        return MASKED
    # A rounded form of a larger value: "$12,346" or "12,345.7" for 12,345.67.
    tolerance = 0.5 if number.is_integer() else 0.05
    if any(v >= 100 and abs(v - number) <= tolerance for v in values):
        return MASKED
    return token
