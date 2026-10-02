"""Scrub secrets from text before it is logged.

A backstop for the rule that credentials never appear in logs: provider keys
belong in headers (not URLs), and third-party HTTP loggers run at WARNING, but
anything that still slips into a log line is redacted here.
"""

import re
from typing import Any

REDACTED = "***"

# ?token=…, &api_key=…, &apikey=…, &key=…, &access_token=…, &secret=…
_SECRET_QUERY_RE = re.compile(
    r"([?&](?:token|api[_-]?key|apikey|key|access[_-]?token|secret|password|"
    r"signature|sig)=)[^&#\s\"'<>]+",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"(\bbearer\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_HEADER_RE = re.compile(
    r"((?:x-internal-token|x-finnhub-token|x-api-key|api-key|authorization)"
    r"[\"']?\s*[:=]\s*[\"']?)(?!bearer\b)[^\s\"',}]+",
    re.IGNORECASE,
)


def redact(text: str) -> str:
    """Replace secret values in URLs, bearer tokens and auth headers."""
    text = _SECRET_QUERY_RE.sub(rf"\g<1>{REDACTED}", text)
    text = _BEARER_RE.sub(rf"\g<1>{REDACTED}", text)
    return _HEADER_RE.sub(rf"\g<1>{REDACTED}", text)


def redact_value(value: Any) -> Any:
    """Redact strings inside (nested) structured log fields."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: redact_value(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact_value(v) for v in value]
    return value
