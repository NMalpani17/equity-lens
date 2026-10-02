"""The Equity Lens MCP server: every analyst tool is defined here, once.

The agent loads these tools through an MCP client (``langchain.mcp``), and the
same server is mounted at ``/mcp`` for other MCP clients behind the internal
token. All tools are read-only: none can create, modify, or delete user data.

Per-user data (portfolio, citation numbering) is resolved from the turn id the
agent's client sends as call ``meta``, never from tool arguments.
"""

import logging
from collections.abc import Callable
from functools import lru_cache
from typing import Annotated, Literal

from fastmcp import Context, FastMCP
from fastmcp.tools import ToolResult
from mcp.types import TextContent, ToolAnnotations
from pydantic import BeforeValidator, Field

from app.config import get_settings
from app.models.price_history import HistoryPeriod
from app.services.market_data.history import get_price_history_service
from app.services.market_data.service import get_market_data_service
from app.services.rag.container import get_rag_components

from . import tools
from .context import TurnContext, turn_id_from_meta, turn_registry
from .resolver import CompanyResolver, finnhub_symbol_search
from .tools import ToolDeps, ToolOutput

logger = logging.getLogger(__name__)

mcp = FastMCP(
    "equity-lens-analyst",
    instructions="Read-only equity research tools: earnings call transcripts, "
    "quotes, price history, the user's portfolio, company/period resolution, "
    "and position math.",
    mask_error_details=True,
)

READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=True,
)


def _clamped(lo: int, hi: int) -> BeforeValidator:
    """Clamp an out-of-range number to [lo, hi] instead of failing the call.

    Runs before the Field constraints, so the schema still advertises the
    limits but a model that overshoots (e.g. top_k=20) gets the nearest
    valid value rather than a validation error and a wasted retry.
    """

    def clamp(value: object) -> object:
        if isinstance(value, bool) or value is None:
            return value
        try:
            number = int(float(value))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return value  # let normal validation report non-numbers
        return min(max(number, lo), hi)

    return BeforeValidator(clamp)


def _quarter_or_none(value: object) -> object:
    """Drop an impossible quarter filter (clamping would pick a wrong one)."""
    try:
        quarter = int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return value
    return quarter if 1 <= quarter <= 4 else None


Ticker = Annotated[
    str,
    Field(
        description="US ticker symbol, e.g. NVDA. Use resolve_company first if "
        "the user gave a company name.",
        min_length=1,
        max_length=10,
    ),
]


@lru_cache
def _resolver() -> CompanyResolver:
    settings = get_settings()
    return CompanyResolver(
        indexed_tickers=lambda: get_rag_components().repo.list_tickers(),
        symbol_search=finnhub_symbol_search(
            settings.finnhub_api_key,
            settings.finnhub_base_url,
            settings.market_http_timeout_seconds,
        ),
    )


def default_tool_deps() -> ToolDeps:
    return ToolDeps(
        search=lambda: get_rag_components().search,
        market=get_market_data_service,
        history=get_price_history_service,
        resolver=_resolver,
        search_top_k=get_settings().chat_search_top_k,
    )


_deps_provider: Callable[[], ToolDeps] = default_tool_deps


def set_tool_deps(provider: Callable[[], ToolDeps]) -> None:
    """Swap tool dependencies (tests)."""
    global _deps_provider
    _deps_provider = provider


def _turn(ctx: Context) -> TurnContext | None:
    request = ctx.request_context
    meta = getattr(request, "meta", None) if request is not None else None
    return turn_registry.get(turn_id_from_meta(meta))


def _result(output: ToolOutput) -> ToolResult:
    return ToolResult(
        content=[TextContent(type="text", text=output.text)],
        structured_content=output.data,
    )


@mcp.tool(annotations=READ_ONLY)
def search_transcripts(
    ctx: Context,
    query: Annotated[
        str,
        Field(
            description="What to look for, in natural language or exact terms.",
            min_length=1,
            max_length=500,
        ),
    ],
    ticker: Annotated[
        str | None, Field(description="Restrict to one ticker.", max_length=10)
    ] = None,
    fiscal_year: Annotated[
        int | None,
        Field(
            description="Company fiscal year, 1990-2100 (see resolve_company). "
            "Omit to search all indexed calls, newest first.",
            ge=1990,
            le=2100,
        ),
        _clamped(1990, 2100),
    ] = None,
    fiscal_quarter: Annotated[
        int | None,
        Field(
            description="Fiscal quarter 1-4; any other value is ignored.",
            ge=1,
            le=4,
        ),
        BeforeValidator(_quarter_or_none),
    ] = None,
    top_k: Annotated[
        int,
        Field(
            description="Passages to return: 1-8 (default 5). Larger values "
            "are capped at 8.",
            ge=1,
            le=8,
        ),
        _clamped(1, 8),
    ] = 5,
) -> ToolResult:
    """Search earnings call transcripts (last four calls per company).

    Returns numbered passages with ticker, fiscal quarter, call date and
    speaker; cite them as [n]. If the company isn't indexed yet, indexing
    starts and the result says to retry shortly.
    """
    return _result(
        tools.search_transcripts(
            _deps_provider(),
            _turn(ctx),
            query=query,
            ticker=ticker,
            fiscal_year=fiscal_year,
            fiscal_quarter=fiscal_quarter,
            top_k=top_k,
        )
    )


@mcp.tool(annotations=READ_ONLY)
def get_quote(ticker: Ticker) -> ToolResult:
    """Latest price, previous close and daily change for a ticker, with timestamp."""
    return _result(tools.get_quote(_deps_provider(), ticker=ticker))


@mcp.tool(annotations=READ_ONLY)
def get_price_history(
    ticker: Ticker,
    period: Annotated[HistoryPeriod, Field(description="Lookback window.")] = "6mo",
) -> ToolResult:
    """Price performance over a period: start/end close, change, high and low
    with dates, and a downsampled close series."""
    return _result(
        tools.get_price_history(_deps_provider(), ticker=ticker, period=period)
    )


@mcp.tool(annotations=READ_ONLY)
def get_portfolio(ctx: Context) -> ToolResult:
    """The current user's holdings: positions with shares, average cost, market
    value, gain/loss and portfolio weight, plus totals."""
    return _result(tools.get_portfolio(_turn(ctx)))


@mcp.tool(annotations=READ_ONLY)
def resolve_company(
    query: Annotated[
        str,
        Field(description="Company name or ticker.", min_length=1, max_length=100),
    ],
    period: Annotated[
        str | None,
        Field(
            description="Optional period phrase to map to the company's fiscal "
            "quarter, e.g. 'last quarter', 'two quarters ago', 'Q3 2025'.",
            max_length=100,
        ),
    ] = None,
) -> ToolResult:
    """Map a company name to its ticker and a period phrase to fiscal
    year/quarter. Returns 'ambiguous' with candidates when several listings
    match (e.g. share classes); then ask the user which they mean."""
    return _result(tools.resolve_company(_deps_provider(), query=query, period=period))


@mcp.tool(annotations=READ_ONLY)
def calculate_position(
    ctx: Context,
    action: Literal["buy", "sell"],
    shares: Annotated[float, Field(gt=0, description="Shares to buy or sell.")],
    price: Annotated[float, Field(gt=0, description="Trade price per share.")],
    ticker: Annotated[
        str | None,
        Field(
            description="If given and the user holds it, their current position "
            "is used unless current_shares/current_avg_cost are provided.",
            max_length=10,
        ),
    ] = None,
    current_shares: Annotated[float | None, Field(ge=0)] = None,
    current_avg_cost: Annotated[float | None, Field(ge=0)] = None,
    market_price: Annotated[
        float | None,
        Field(gt=0, description="Price to value the resulting position at."),
    ] = None,
) -> ToolResult:
    """Exact math for a hypothetical trade: new share count, new average cost,
    cost basis, realized gain on sells, and unrealized gain at a market price.
    Always use this instead of doing arithmetic yourself."""
    return _result(
        tools.calculate_position_tool(
            _turn(ctx),
            action=action,
            shares=shares,
            price=price,
            ticker=ticker,
            current_shares=current_shares,
            current_avg_cost=current_avg_cost,
            market_price=market_price,
        )
    )
