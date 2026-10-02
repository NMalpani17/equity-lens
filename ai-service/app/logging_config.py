"""Structured logging setup.

Emits one JSON object per log line so logs are machine-parseable in any
environment. Configured once at startup via :func:`configure_logging`.
"""

import json
import logging
from datetime import UTC, datetime

from app.redaction import redact, redact_value

# HTTP client libraries log every request URL at INFO. Keep them at WARNING so
# request URLs (which may carry credentials) aren't routinely logged.
_QUIET_HTTP_LOGGERS = ("httpx", "httpx2", "httpcore", "httpcore2", "urllib3")


class JsonFormatter(logging.Formatter):
    """Format log records as single-line JSON, with secrets redacted."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": redact(record.getMessage()),
        }
        # Structured fields passed as ``logger.info(msg, extra={"fields": {...}})``.
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            payload.update(redact_value(fields))
        if record.exc_info:
            payload["exception"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload)


def configure_logging(log_level: str = "INFO") -> None:
    """Configure the root logger to emit structured JSON logs."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(log_level.upper())

    # langchain-google-genai warns once per tool-schema key it drops (e.g.
    # MCP's additionalProperties) on every model call; it's expected noise.
    logging.getLogger("langchain_google_genai._function_utils").setLevel(logging.ERROR)
    for name in _QUIET_HTTP_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    # FastMCP logs to its own console handlers and doesn't propagate. Route it
    # through ours, so tool failures (logged with tracebacks) are JSON and
    # redacted like everything else. Clients still get only a masked error.
    fastmcp_logger = logging.getLogger("fastmcp")
    fastmcp_logger.handlers.clear()
    fastmcp_logger.propagate = True
