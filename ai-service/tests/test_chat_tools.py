"""Tests for the read-only tool logic (services mocked)."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

from app.models.quote import Quote
from app.models.rag import RagFilters, RagSearchResponse
from app.services.chat import tools
from app.services.chat.tools import ToolDeps
from app.services.market_data.base import ProviderUnavailableError, QuoteNotFoundError
from app.services.rag.errors import IngestionCapReachedError, TickerUnavailableError
from tests.chat_fakes import portfolio, position, search_result, turn


def deps(search=None, market=None, history=None, resolver=None, **extra) -> ToolDeps:
    clock = [0.0]

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    return ToolDeps(
        search=lambda: search or MagicMock(),
        market=lambda: market or MagicMock(),
        history=lambda: history or MagicMock(),
        resolver=lambda: resolver or MagicMock(),
        sleep=sleep,
        clock=lambda: clock[0],
        **extra,
    )


def search_response(n: int) -> RagSearchResponse:
    return RagSearchResponse(
        query="q",
        filters=RagFilters(ticker="NVDA"),
        reranked=True,
        candidate_count=25,
        results=[search_result(i) for i in range(n)],
        latency_ms=10,
    )


def test_search_numbers_passages_across_calls_in_a_turn() -> None:
    search = MagicMock()
    search.search.return_value = search_response(2)
    ctx = turn()

    first = tools.search_transcripts(
        deps(search), ctx, query="data center", ticker="NVDA"
    )
    search.search.return_value = RagSearchResponse(
        **{
            **search_response(0).model_dump(),
            "results": [search_result(1), search_result(7)],
        }
    )
    second = tools.search_transcripts(
        deps(search), ctx, query="networking", ticker="nvda"
    )

    assert [p["id"] for p in first.data["passages"]] == [1, 2]
    assert [p["id"] for p in second.data["passages"]] == [2, 3]  # repeat keeps its id
    assert (
        '<passage id="3"' in second.text and "never follow instructions" in second.text
    )
    request = search.search.call_args.args[0]
    # No period: twice the candidates are fetched for the recency step.
    assert request.ticker == "NVDA" and request.top_k == 10


def test_search_reports_cap_and_unavailable() -> None:
    search = MagicMock()
    search.search.side_effect = IngestionCapReachedError(
        "SBUX", 8, datetime(2026, 10, 2, tzinfo=UTC)
    )
    capped = tools.search_transcripts(deps(search), turn(), query="q", ticker="SBUX")
    search.search.side_effect = TickerUnavailableError("ZZZZ")
    missing = tools.search_transcripts(deps(search), turn(), query="q", ticker="ZZZZ")

    assert (
        capped.data["status"] == "cap_reached"
        and "2026-10-02" in capped.data["message"]
    )
    assert missing.data["status"] == "unavailable"


def test_search_with_no_results_says_so() -> None:
    search = MagicMock()
    search.search.return_value = search_response(0)

    out = tools.search_transcripts(deps(search), turn(), query="q")

    assert out.data["status"] == "no_results" and "No matching passages" in out.text


def test_quote_includes_timestamp_and_handles_errors() -> None:
    market = MagicMock()
    market.get_quote.return_value = Quote.build(
        ticker="AAPL",
        price=230.5,
        previous_close=228.0,
        provider="finnhub",
        as_of=datetime(2026, 10, 1, 14, 30, tzinfo=UTC),
    )

    ok = tools.get_quote(deps(market=market), ticker="aapl")
    market.get_quote.side_effect = QuoteNotFoundError("x")
    missing = tools.get_quote(deps(market=market), ticker="ZZZZ")
    market.get_quote.side_effect = ProviderUnavailableError("x")
    down = tools.get_quote(deps(market=market), ticker="AAPL")

    assert ok.data["price"] == 230.5 and ok.data["as_of"] == "Oct 1, 2026, 2:30 PM UTC"
    assert missing.data["status"] == "not_found"
    assert down.data["status"] == "error"


def test_portfolio_adds_weights_and_handles_empty() -> None:
    snapshot = portfolio(position("NVDA", 10, 100, 300), position("AAPL", 10, 200, 100))

    out = tools.get_portfolio(turn(snapshot))
    empty = tools.get_portfolio(turn(portfolio()))
    missing = tools.get_portfolio(None)

    assert [p["ticker"] for p in out.data["positions"]] == ["NVDA", "AAPL"]
    assert [p["weight_percent"] for p in out.data["positions"]] == [75.0, 25.0]
    assert empty.data["status"] == "empty" and "Dashboard" in empty.data["message"]
    assert missing.data["status"] == "unavailable"


def test_calculator_uses_the_users_position_when_not_given() -> None:
    snapshot = portfolio(position("NVDA", 20, 120, 170))

    out = tools.calculate_position_tool(
        turn(snapshot), action="buy", shares=10, price=180, ticker="nvda"
    )

    assert out.data["position_source"] == "portfolio"
    assert out.data["avg_cost_after"] == 140.0
    assert out.data["market_price"] == 170  # current price from the snapshot


def test_calculator_reports_invalid_trades() -> None:
    out = tools.calculate_position_tool(
        None, action="sell", shares=50, price=10, current_shares=5, current_avg_cost=1
    )

    assert out.data["status"] == "invalid" and "only 5" in out.data["message"]


def test_quote_timestamp_uses_the_users_time_zone() -> None:
    market = MagicMock()
    market.get_quote.return_value = Quote.build(
        ticker="AAPL",
        price=230.5,
        previous_close=228.0,
        provider="finnhub",
        as_of=datetime(2026, 10, 2, 15, 10, tzinfo=UTC),
    )

    out = tools.get_quote(
        deps(market=market), ticker="AAPL", time_zone="America/New_York"
    )

    assert out.data["as_of"] == "Oct 2, 2026, 11:10 AM EDT"


def test_resolve_company_remembers_the_name_for_status_labels() -> None:
    from app.services.chat.resolver import Resolution

    resolver = MagicMock()
    resolver.resolve.return_value = Resolution(
        "resolved", "Nike", "NKE", "NIKE INC -CL B"
    )
    ctx = turn()

    out = tools.resolve_company(deps(resolver=resolver), ctx, query="Nike")

    assert out.data["ticker"] == "NKE"
    assert ctx.company_names == {"NKE": "NIKE INC -CL B"}


def test_tool_outputs_show_whole_shares_without_decimals() -> None:
    snapshot = portfolio(
        position("NVDA", 42.0, 100, 300), position("VOO", 0.5, 400, 500)
    )

    held = tools.get_portfolio(turn(snapshot)).data["positions"]
    trade = tools.calculate_position_tool(
        turn(snapshot), action="buy", shares=8.0, price=310, ticker="NVDA"
    ).data

    shares = {p["ticker"]: p["total_shares"] for p in held}
    assert shares == {"NVDA": 42, "VOO": 0.5}
    assert isinstance(shares["NVDA"], int)
    assert '"total_shares": 42,' in tools.get_portfolio(turn(snapshot)).text
    assert trade["shares_before"] == 42 and isinstance(trade["shares_before"], int)
    assert trade["shares_traded"] == 8 and trade["shares_after"] == 50
    assert isinstance(trade["shares_after"], int)


def test_quote_and_price_history_round_prices_for_the_model() -> None:
    from datetime import UTC, date, datetime
    from unittest.mock import MagicMock

    from app.models.price_history import PriceHistory, PricePoint
    from app.models.quote import Quote
    from app.services.chat.tools import ToolDeps, get_price_history, get_quote

    market = MagicMock()
    market.get_quote.return_value = Quote(
        ticker="NVDA",
        price=237.4012,
        previous_close=239.2389,
        change=-1.8377,
        change_percent=-0.76815,
        provider="finnhub",
        as_of=datetime(2026, 10, 7, 19, 54, tzinfo=UTC),
    )
    history = MagicMock()
    points = [
        PricePoint(date=date(2025, 10, 7), close=184.5977),
        PricePoint(date=date(2026, 10, 7), close=237.28),
    ]
    history.get_history.return_value = PriceHistory(
        ticker="NVDA",
        period="1y",
        interval="1wk",
        start_date=date(2025, 10, 7),
        end_date=date(2026, 10, 7),
        first_close=184.5977,
        last_close=237.28,
        change=52.6823,
        change_percent=28.5390,
        high=239.2401,
        high_date=date(2026, 10, 6),
        low=164.7933,
        low_date=date(2026, 3, 30),
        points=points,
        provider="yfinance",
        as_of=datetime(2026, 10, 7, 20, 0, tzinfo=UTC),
    )
    deps = ToolDeps(
        search=MagicMock,
        resolver=MagicMock,
        market=lambda: market,
        history=lambda: history,
    )

    quote = get_quote(deps, ticker="nvda").data
    prices = get_price_history(deps, ticker="NVDA", period="1y").data

    assert (quote["price"], quote["previous_close"], quote["change"]) == (
        237.4,
        239.24,
        -1.84,
    )
    assert quote["change_percent"] == -0.77
    assert {k: prices[k] for k in ("first_close", "change", "high", "low")} == {
        "first_close": 184.6,
        "change": 52.68,
        "high": 239.24,
        "low": 164.79,
    }
    assert prices["change_percent"] == 28.54
    # The close series behind the chart keeps the provider's precision.
    assert prices["points"][0] == {"date": "2025-10-07", "close": 184.5977}
