"""Secrets must never reach the logs."""

import json
import logging
import sys

import httpx
import pytest

from app.logging_config import JsonFormatter, configure_logging
from app.redaction import redact
from app.services.chat.resolver import finnhub_symbol_search
from app.services.market_data.finnhub import FinnhubProvider

SECRET = "sk_live_abc123SECRET"


@pytest.mark.parametrize(
    "text",
    [
        f"HTTP Request: GET https://finnhub.io/api/v1/quote?q=X&token={SECRET} 200",
        f"GET https://api.example.com/v1/x?api_key={SECRET}&q=1",
        f"GET https://api.example.com/v1/x?apikey={SECRET}",
        f"GET https://api.example.com/v1/x?key={SECRET}",
        f"GET https://api.example.com/v1/x?access_token={SECRET}#frag",
        f"Authorization: Bearer {SECRET}",
        f"headers={{'authorization': 'Bearer {SECRET}'}}",
        f"x-internal-token: {SECRET}",
        f'{{"X-Finnhub-Token": "{SECRET}"}}',
    ],
)
def test_redact_scrubs_secret_values(text: str) -> None:
    out = redact(text)

    assert SECRET not in out
    assert "***" in out


def test_redact_keeps_ordinary_text_and_params() -> None:
    text = "GET https://finnhub.io/api/v1/quote?symbol=AAPL 200 (tokens used: 120)"

    assert redact(text) == text


def record(msg: str, *args, **extra) -> logging.LogRecord:
    rec = logging.LogRecord("httpx", logging.INFO, __file__, 1, msg, args, None)
    for key, value in extra.items():
        setattr(rec, key, value)
    return rec


def test_formatter_redacts_messages_fields_and_exceptions() -> None:
    formatter = JsonFormatter()
    url = f"https://finnhub.io/api/v1/quote?symbol=AAPL&token={SECRET}"

    message = json.loads(formatter.format(record("HTTP Request: GET %s", url)))
    fields = json.loads(
        formatter.format(
            record(
                "call", fields={"url": url, "nested": [{"auth": f"Bearer {SECRET}"}]}
            )
        )
    )
    try:
        raise RuntimeError(f"request failed for {url}")
    except RuntimeError:
        rec = record("failed")
        rec.exc_info = sys.exc_info()
        exc = json.loads(formatter.format(rec))

    for payload in (message, fields, exc):
        assert SECRET not in json.dumps(payload)
    assert message["message"].endswith("token=***")


def test_http_client_loggers_run_at_warning() -> None:
    configure_logging("INFO")

    for name in ("httpx", "httpx2", "httpcore"):
        assert logging.getLogger(name).getEffectiveLevel() == logging.WARNING


def test_finnhub_sends_the_key_in_a_header_not_the_url(monkeypatch) -> None:
    seen: list[tuple[str, dict, dict]] = []

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append((url, dict(params or {}), dict(headers or {})))
        return httpx.Response(
            200,
            json={"c": 150.0, "pc": 148.0, "name": "Apple", "result": []},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)

    FinnhubProvider(SECRET).get_quote("AAPL")
    finnhub_symbol_search(SECRET, "https://finnhub.io/api/v1", 5)("apple")

    assert seen
    for url, params, headers in seen:
        assert SECRET not in url
        assert SECRET not in json.dumps(params)
        assert headers["X-Finnhub-Token"] == SECRET


def test_tool_failures_are_logged_with_a_redacted_traceback_only_on_the_server(
    capsys,
) -> None:
    import asyncio
    from unittest.mock import MagicMock

    from fastmcp import Client

    from app.services.chat import mcp_server
    from app.services.chat.tools import ToolDeps

    def failing_search():
        raise RuntimeError(f"pool connect failed for postgres://db?password={SECRET}")

    search = MagicMock()
    search.search.side_effect = lambda *_: failing_search()
    deps = ToolDeps(
        search=lambda: search, market=MagicMock, history=MagicMock, resolver=MagicMock
    )
    mcp_server.set_tool_deps(lambda: deps)
    configure_logging("INFO")  # routes FastMCP's logger through our JSON handler

    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool(
                "search_transcripts",
                {"query": "demand", "ticker": "NVDA"},
                raise_on_error=False,
            )

    try:
        result = asyncio.run(call())
    finally:
        mcp_server.set_tool_deps(mcp_server.default_tool_deps)

    # The client (the model, and so Langfuse) sees only a masked error.
    client_text = result.content[0].text
    assert result.is_error and client_text == "Error calling tool 'search_transcripts'"
    assert "Traceback" not in client_text and SECRET not in client_text
    # The server log has the full traceback, as JSON, with the secret redacted.
    err = capsys.readouterr().err
    lines = [json.loads(line) for line in err.splitlines() if line.startswith("{")]
    failure = next(
        line for line in lines if line["message"].startswith("Error calling tool")
    )
    assert failure["level"] == "ERROR" and failure["logger"].startswith("fastmcp")
    assert (
        "Traceback" in failure["exception"] and "failing_search" in failure["exception"]
    )
    assert SECRET not in err
