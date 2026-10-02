"""Tests for the MCP tool server via an in-memory FastMCP client."""

import asyncio
from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from fastmcp import Client

from app.models.rag import RagFilters, RagSearchResponse
from app.services.chat import mcp_server
from app.services.chat.context import TURN_META_KEY, turn_registry
from app.services.chat.tools import ToolDeps
from tests.chat_fakes import portfolio, position, search_result, turn

EXPECTED_TOOLS = {
    "search_transcripts",
    "get_quote",
    "get_price_history",
    "get_portfolio",
    "resolve_company",
    "calculate_position",
}


@pytest.fixture
def search() -> Iterator[MagicMock]:
    search = MagicMock()
    search.search.return_value = RagSearchResponse(
        query="q",
        filters=RagFilters(),
        reranked=True,
        candidate_count=3,
        results=[search_result(0), search_result(1)],
        latency_ms=5,
    )
    deps = ToolDeps(
        search=lambda: search,
        market=MagicMock,
        history=MagicMock,
        resolver=MagicMock,
    )
    mcp_server.set_tool_deps(lambda: deps)
    yield search
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


def run(coro):
    return asyncio.run(coro)


async def call(name: str, args: dict, turn_id: str | None = None):
    async with Client(mcp_server.mcp) as client:
        meta = {TURN_META_KEY: turn_id} if turn_id else None
        return await client.call_tool(name, args, meta=meta, raise_on_error=False)


def test_server_exposes_exactly_the_read_only_tools() -> None:
    async def list_tools():
        async with Client(mcp_server.mcp) as client:
            return await client.list_tools()

    listed = run(list_tools())

    assert {t.name for t in listed} == EXPECTED_TOOLS
    for tool in listed:
        assert tool.annotations.read_only_hint is True, tool.name
        assert tool.annotations.destructive_hint is False, tool.name
        assert "ctx" not in tool.input_schema.get("properties", {}), tool.name


def test_portfolio_is_resolved_from_turn_meta_not_arguments(search) -> None:
    ctx = turn(portfolio(position("NVDA", 10, 100, 150)))
    turn_registry.register(ctx)
    try:
        with_turn = run(call("get_portfolio", {}, ctx.turn_id))
        without = run(call("get_portfolio", {}))
        unknown = run(call("get_portfolio", {}, "not-a-real-turn"))
    finally:
        turn_registry.discard(ctx.turn_id)

    assert with_turn.structured_content["positions"][0]["ticker"] == "NVDA"
    assert without.structured_content["status"] == "unavailable"
    assert unknown.structured_content["status"] == "unavailable"


def test_search_numbers_passages_within_the_turn(search) -> None:
    ctx = turn()
    turn_registry.register(ctx)
    try:
        result = run(
            call(
                "search_transcripts", {"query": "demand", "ticker": "NVDA"}, ctx.turn_id
            )
        )
    finally:
        turn_registry.discard(ctx.turn_id)

    assert [p["id"] for p in result.structured_content["passages"]] == [1, 2]
    assert len(ctx.sources) == 2  # the agent validates citations against these
    assert '<passage id="1"' in result.content[0].text


def test_invalid_arguments_are_rejected_by_the_schema(search) -> None:
    result = run(call("search_transcripts", {"query": ""}))

    assert result.is_error


def test_mcp_http_endpoint_requires_the_internal_token(monkeypatch) -> None:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setattr(get_settings(), "internal_token", "secret-token")
    with TestClient(create_app()) as client:
        denied = client.post("/mcp/", json={})
        wrong = client.post("/mcp/", json={}, headers={"Authorization": "Bearer nope"})
        allowed = client.post(
            "/mcp/", json={}, headers={"Authorization": "Bearer secret-token"}
        )

    assert denied.status_code == 401 and wrong.status_code == 401
    assert allowed.status_code != 401


@pytest.mark.parametrize(
    ("args", "expected_top_k"),
    [({"top_k": 50}, 8), ({"top_k": 0}, 1), ({"top_k": -3}, 1), ({"top_k": 7.9}, 7)],
)
def test_out_of_range_top_k_is_clamped_not_rejected(
    search, args, expected_top_k
) -> None:
    result = run(
        call("search_transcripts", {"query": "demand", "fiscal_year": 2027, **args})
    )

    assert not result.is_error
    assert search.search.call_args.args[0].top_k == expected_top_k


def test_out_of_range_periods_are_clamped_or_dropped(search) -> None:
    result = run(
        call(
            "search_transcripts",
            {"query": "q", "fiscal_year": 1800, "fiscal_quarter": 7},
        )
    )

    request = search.search.call_args.args[0]
    assert not result.is_error
    assert request.fiscal_year == 1990
    assert request.fiscal_quarter is None


def test_limits_are_stated_in_the_tool_schema() -> None:
    async def schema():
        async with Client(mcp_server.mcp) as client:
            tools = await client.list_tools()
        return next(t for t in tools if t.name == "search_transcripts").input_schema

    props = run(schema())["properties"]

    assert props["top_k"]["maximum"] == 8 and props["top_k"]["minimum"] == 1
    assert "1-8" in props["top_k"]["description"]
    assert "1-4" in str(props["fiscal_quarter"])
