"""Inline charts: built from tool results only, streamed and attached to `done`."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from app.config import Settings
from app.models.chat import AllocationChart, ChatTurnRequest, PriceChart
from app.models.price_history import PriceHistory, PricePoint
from app.services.chat import mcp_server
from app.services.chat.agent import ChatService
from app.services.chat.charts import (
    MAX_ALLOCATION_SLICES,
    OTHER_TICKER,
    build_chart,
    chart_key,
)
from app.services.chat.context import turn_registry
from app.services.chat.tools import ToolDeps, get_portfolio
from app.services.market_data.base import QuoteNotFoundError
from tests.chat_fakes import ScriptedChatModel, ai, portfolio, position, turn


def history(ticker: str = "NVDA", period: str = "6mo") -> PriceHistory:
    start = date(2026, 4, 1)
    closes = [100.0, 104.5, 98.25, 120.0]
    return PriceHistory(
        ticker=ticker,
        period=period,
        interval="1d",
        start_date=start,
        end_date=start + timedelta(days=3),
        first_close=100.0,
        last_close=120.0,
        change=20.0,
        change_percent=20.0,
        high=120.0,
        high_date=start + timedelta(days=3),
        low=98.25,
        low_date=start + timedelta(days=2),
        points=[
            PricePoint(date=start + timedelta(days=i), close=c)
            for i, c in enumerate(closes)
        ],
        provider="yfinance",
        as_of=datetime(2026, 10, 1, 20, 0, tzinfo=UTC),
    )


def history_result(**kwargs) -> dict:
    return {"status": "ok", **history(**kwargs).model_dump(mode="json")}


# --- build_chart ------------------------------------------------------------------


def test_price_history_result_becomes_a_price_chart_with_tool_numbers() -> None:
    chart = build_chart("get_price_history", history_result(), "chart-1")

    assert isinstance(chart, PriceChart)
    assert chart.id == "chart-1" and chart.ticker == "NVDA" and chart.period == "6mo"
    assert [p.close for p in chart.points] == [100.0, 104.5, 98.25, 120.0]
    assert (chart.first_close, chart.last_close, chart.change_percent) == (
        100.0,
        120.0,
        20.0,
    )
    assert chart_key(chart) == "price:NVDA:6mo"


def test_portfolio_result_becomes_an_allocation_chart_sorted_by_value() -> None:
    snapshot = portfolio(position("AAPL", 10, 150, 200), position("NVDA", 20, 100, 150))
    data = get_portfolio(turn(snapshot)).data

    chart = build_chart("get_portfolio", data, "chart-p")

    assert isinstance(chart, AllocationChart)
    assert [(s.ticker, s.market_value) for s in chart.slices] == [
        ("NVDA", 3000.0),
        ("AAPL", 2000.0),
    ]
    assert [s.weight_percent for s in chart.slices] == [60.0, 40.0]
    assert chart.total_market_value == 5000.0 and chart.partial is False


def test_unpriced_positions_are_left_out_and_flagged_partial() -> None:
    unpriced = position("XYZ", 5, 10, 10).model_copy(
        update={
            "market_value": None,
            "current_price": None,
            "price_status": "unavailable",
        }
    )
    data = get_portfolio(turn(portfolio(position("NVDA", 1, 100, 150), unpriced))).data

    chart = build_chart("get_portfolio", data, "c")

    assert isinstance(chart, AllocationChart)
    assert [s.ticker for s in chart.slices] == ["NVDA"] and chart.partial is True


def test_many_holdings_are_grouped_into_other() -> None:
    holdings = [position(f"T{i:02d}", 1, 10, 100 - i) for i in range(12)]
    data = get_portfolio(turn(portfolio(*holdings))).data

    chart = build_chart("get_portfolio", data, "c")

    assert isinstance(chart, AllocationChart)
    assert len(chart.slices) == MAX_ALLOCATION_SLICES
    other = chart.slices[-1]
    assert other.ticker == OTHER_TICKER and other.name == "5 other holdings"
    assert (
        round(sum(s.market_value for s in chart.slices), 2) == chart.total_market_value
    )


@pytest.mark.parametrize(
    ("tool", "data"),
    [
        ("get_quote", {"status": "ok", "ticker": "NVDA", "price": 1.0}),
        ("get_price_history", {"status": "not_found", "ticker": "ZZZZ"}),
        (
            "get_price_history",
            {**history_result(), "points": [history_result()["points"][0]]},
        ),
        ("get_price_history", {"status": "ok", "ticker": "NVDA"}),  # malformed
        ("get_portfolio", {"status": "empty", "message": "no holdings"}),
        ("get_portfolio", {"status": "ok", "positions": []}),
        ("get_price_history", None),
    ],
)
def test_results_without_chartable_data_produce_no_chart(tool, data) -> None:
    assert build_chart(tool, data, "c") is None


# --- streamed through the agent ------------------------------------------------------


@pytest.fixture
def history_service() -> Iterator[MagicMock]:
    service = MagicMock()
    service.get_history.side_effect = lambda ticker, period: history(ticker, period)
    deps = ToolDeps(
        search=MagicMock, market=MagicMock, history=lambda: service, resolver=MagicMock
    )
    mcp_server.set_tool_deps(lambda: deps)
    yield service
    mcp_server.set_tool_deps(mcp_server.default_tool_deps)


def run_turn(model: ScriptedChatModel, message: str, **kwargs) -> list:
    service = ChatService(
        Settings(_env_file=None, internal_token="t", gemini_api_key="k"),
        lambda: model,
        mcp_server.mcp,
        turn_registry,
        today=lambda _tz: date(2026, 10, 1),
    )
    request = ChatTurnRequest(user_id="user-1", message=message, **kwargs)

    async def collect():
        return [event async for event in service.stream_turn(request)]

    return asyncio.run(collect())


def price_call(call_id: str, ticker: str = "NVDA", period: str = "6mo") -> dict:
    return {
        "name": "get_price_history",
        "args": {"ticker": ticker, "period": period},
        "id": call_id,
    }


def test_chart_event_follows_tool_end_and_is_saved_with_the_answer(
    history_service,
) -> None:
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[price_call("h1")]),
            # The model's own numbers never reach the chart.
            ai("NVDA rose 999% to $5,000 over six months."),
        ]
    )

    events = run_turn(model, "How has NVDA traded over 6 months?")

    types = [e.type for e in events]
    assert types.index("chart") == types.index("tool_end") + 1
    chart = next(e.data for e in events if e.type == "chart")
    assert chart["kind"] == "price_history" and chart["id"] == "chart-h1"
    assert [p["close"] for p in chart["points"]] == [100.0, 104.5, 98.25, 120.0]
    assert chart["points"][0]["date"] == "2026-04-01"
    done = events[-1].data
    assert done["status"] == "complete" and done["charts"] == [chart]


def test_repeated_charts_are_deduplicated_and_portfolio_is_charted(
    history_service,
) -> None:
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[price_call("h1"), {"name": "get_portfolio", "id": "p1"}]),
            ai(tool_calls=[price_call("h2"), price_call("h3", "AAPL", "1y")]),
            ai("Here is the picture."),
        ]
    )
    snapshot = portfolio(position("NVDA", 10, 100, 150))

    events = run_turn(model, "Compare NVDA with my portfolio", portfolio=snapshot)

    charts = events[-1].data["charts"]
    assert [(c["kind"], c["id"]) for c in charts] == [
        ("price_history", "chart-h2"),
        ("portfolio_allocation", "chart-p1"),
        ("price_history", "chart-h3"),
    ]
    assert charts[1]["slices"] == [
        {
            "ticker": "NVDA",
            "name": None,
            "market_value": 1500.0,
            "weight_percent": 100.0,
        }
    ]


def test_failed_or_blocked_answers_keep_no_charts(history_service) -> None:
    model = ScriptedChatModel(
        script=[
            ai(tool_calls=[price_call("h1")]),
            ai("", finish_reason="SAFETY"),
        ]
    )

    events = run_turn(model, "How has NVDA traded?")

    assert any(e.type == "chart" for e in events)
    assert events[-1].data["status"] == "blocked"
    assert events[-1].data["charts"] == []


def test_tool_errors_produce_no_chart(history_service) -> None:
    history_service.get_history.side_effect = QuoteNotFoundError("ZZZZ")
    model = ScriptedChatModel(
        script=[ai(tool_calls=[price_call("h1", "ZZZZ")]), ai("No data for ZZZZ.")]
    )

    events = run_turn(model, "How has ZZZZ traded?")

    assert not any(e.type == "chart" for e in events)
    assert events[-1].data["charts"] == []
