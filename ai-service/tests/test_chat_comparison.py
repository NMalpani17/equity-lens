"""The compare_quarters chat tool, its MCP registration, labels and prompt rules."""

import asyncio
from datetime import UTC, date, datetime
from unittest.mock import MagicMock

from fastmcp import Client

from app.models.comparison import FiscalPeriod, QuarterComparison, ThemePassages
from app.services.chat import mcp_server
from app.services.chat.comparison import NOT_DISCUSSED, compare_quarters
from app.services.chat.progress import tool_label, tool_summary
from app.services.chat.prompt import build_system_prompt
from app.services.chat.tools import ToolDeps
from app.services.chat.transcripts import SearchDeps
from app.services.rag.errors import TickerUnavailableError
from app.services.rag.repository import TickerRecord
from tests.chat_fakes import search_result, turn


def passage(i: int, quarter: int, ticker: str = "NVDA"):
    return search_result(i, ticker=ticker).model_copy(
        update={
            "id": f"{ticker}#FY2027Q{quarter}#{i:04d}",
            "fiscal_quarter": quarter,
            "text": f"Passage {i} from Q{quarter}.",
        }
    )


def comparison(**overrides) -> QuarterComparison:
    fields = {
        "status": "ok",
        "ticker": "NVDA",
        "company_name": "Nvidia Corp",
        "current": FiscalPeriod(fiscal_year=2027, fiscal_quarter=2),
        "prior": FiscalPeriod(fiscal_year=2027, fiscal_quarter=1),
        "reranked": True,
        "themes": [
            ThemePassages(
                key="guidance",
                label="Guidance and outlook",
                current=[passage(1, 2), passage(2, 2)],
                prior=[passage(3, 1)],
            ),
            ThemePassages(
                key="capital",
                label="Capital allocation",
                current=[],
                prior=[passage(4, 1)],
            ),
        ],
        "available_quarters": ["FY2027Q2", "FY2027Q1"],
    }
    return QuarterComparison(**{**fields, **overrides})


def indexed(ticker: str, status: str = "indexed") -> TickerRecord:
    return TickerRecord(
        ticker,
        status,
        f"{ticker} Inc",
        100,
        ["FY2027Q2", "FY2027Q1"],
        indexed_at=datetime(2026, 9, 1, tzinfo=UTC) if status == "indexed" else None,
    )


def make_deps(service: MagicMock, records=None) -> tuple[SearchDeps, list[float]]:
    clock = [0.0]
    records = records if records is not None else {"NVDA": indexed("NVDA")}

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    deps = SearchDeps(
        search=MagicMock,
        resolver=MagicMock,
        comparison=lambda: service,
        ticker_record=records if callable(records) else records.get,
        sleep=sleep,
        clock=lambda: clock[0],
    )
    return deps, clock


def test_passages_are_grouped_by_theme_and_quarter_with_citation_ids() -> None:
    service = MagicMock()
    service.compare.return_value = comparison()
    deps, _ = make_deps(service)
    ctx = turn()

    out = compare_quarters(deps, ctx, ticker="nvda", focus="margins")

    service.compare.assert_called_once_with(
        "NVDA", current=None, prior=None, focus="margins"
    )
    assert out.data["status"] == "ok"
    assert out.data["themes"] == [
        {
            "key": "guidance",
            "label": "Guidance and outlook",
            "current": [1, 2],
            "prior": [3],
        },
        {"key": "capital", "label": "Capital allocation", "current": [], "prior": [4]},
    ]
    # Citation ids come from the turn's registry, so they validate later.
    assert len(ctx.sources) == 4
    assert ctx.sources.get(3).chunk_id == "NVDA#FY2027Q1#0003"
    assert [p["fiscal_quarter"] for p in out.data["passages"]] == [2, 2, 1, 1]
    text = out.text
    assert text.index("## Guidance and outlook") < text.index("## Capital allocation")
    assert text.index("### Q2 FY2027 (newer)") < text.index("### Q1 FY2027 (earlier)")
    assert '<passage id="1" ticker="NVDA" period="Q2 FY2027">' in text
    assert "Cite every claim with a passage from the quarter it describes" in text


def test_a_quarter_without_passages_is_not_discussed_never_dropped() -> None:
    service = MagicMock()
    service.compare.return_value = comparison()
    deps, _ = make_deps(service)

    out = compare_quarters(deps, turn(), ticker="NVDA")

    capital = out.text[out.text.index("## Capital allocation") :]
    assert capital.index(NOT_DISCUSSED) < capital.index("### Q1 FY2027 (earlier)")
    assert "never that management dropped the topic" in out.text


def test_explicit_quarters_are_passed_through() -> None:
    service = MagicMock()
    service.compare.return_value = comparison()
    deps, _ = make_deps(service)

    compare_quarters(
        deps,
        turn(),
        ticker="NVDA",
        current_fiscal_year=2027,
        current_fiscal_quarter=2,
        prior_fiscal_year=2026,
        prior_fiscal_quarter=4,
    )

    assert service.compare.call_args.kwargs["current"] == (2027, 2)
    assert service.compare.call_args.kwargs["prior"] == (2026, 4)


def test_a_year_without_its_quarter_is_rejected_before_any_search() -> None:
    service = MagicMock()
    deps, _ = make_deps(service)

    out = compare_quarters(deps, turn(), ticker="NVDA", current_fiscal_year=2027)

    assert out.data["status"] == "invalid_quarters"
    service.compare.assert_not_called()


def test_statuses_are_relayed_with_the_indexed_quarters() -> None:
    service = MagicMock()
    service.compare.return_value = QuarterComparison(
        status="quarter_not_indexed",
        ticker="NVDA",
        available_quarters=["FY2027Q2", "FY2027Q1"],
        message="FY2025Q4 is not indexed for NVDA. Indexed quarters: FY2027Q2, "
        "FY2027Q1.",
    )
    deps, _ = make_deps(service)

    out = compare_quarters(
        deps, turn(), ticker="NVDA", current_fiscal_year=2025, current_fiscal_quarter=4
    )

    assert out.data == {
        "status": "quarter_not_indexed",
        "ticker": "NVDA",
        "message": service.compare.return_value.message,
        "available_quarters": ["FY2027Q2", "FY2027Q1"],
    }


def test_a_new_ticker_waits_for_indexing_then_compares() -> None:
    service = MagicMock()
    ready = comparison(ticker="AMD")
    service.compare.side_effect = [
        QuarterComparison(status="indexing", ticker="AMD", message="indexing"),
        ready,
    ]
    polls = iter([indexed("AMD", "indexing"), indexed("AMD")])
    deps, clock = make_deps(
        service, records=lambda t: next(polls) if t == "AMD" else None
    )
    progress: list[str] = []
    ctx = turn()
    ctx.progress = progress.append

    out = compare_quarters(deps, ctx, ticker="AMD")

    assert out.data["status"] == "ok"
    assert service.compare.call_count == 2
    assert progress[0].startswith("Indexing")
    assert clock[0] > 0


def test_unavailable_tickers_are_reported_by_the_existing_guard() -> None:
    service = MagicMock()
    service.compare.side_effect = TickerUnavailableError("ZZZZ")
    deps, _ = make_deps(service, records={})

    out = compare_quarters(deps, turn(), ticker="ZZZZ")

    assert out.data["status"] == "unavailable"


def test_share_classes_compare_the_indexed_class() -> None:
    service = MagicMock()
    service.compare.return_value = comparison(ticker="GOOGL")
    deps, _ = make_deps(service, records={"GOOGL": indexed("GOOGL")})

    out = compare_quarters(deps, turn(), ticker="GOOG")

    assert service.compare.call_args.args[0] == "GOOGL"
    assert "share classes" in out.data["note"]


# --- MCP, progress labels and the prompt ----------------------------------------------


def test_the_mcp_tool_drops_an_impossible_quarter_and_reports_it() -> None:
    service = MagicMock()
    service.compare.return_value = comparison()
    deps = ToolDeps(
        search=MagicMock,
        market=MagicMock,
        history=MagicMock,
        resolver=MagicMock,
        comparison=lambda: service,
        ticker_record={"NVDA": indexed("NVDA")}.get,
    )
    mcp_server.set_tool_deps(lambda: deps)

    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool(
                "compare_quarters",
                {
                    "ticker": "NVDA",
                    "current_fiscal_year": 2027,
                    "current_fiscal_quarter": 9,
                },
                raise_on_error=False,
            )

    try:
        result = asyncio.run(call())
    finally:
        mcp_server.set_tool_deps(mcp_server.default_tool_deps)

    # An impossible quarter is dropped, leaving a year without a quarter.
    assert result.structured_content["status"] == "invalid_quarters"
    service.compare.assert_not_called()


def test_the_mcp_tool_passes_focus_and_quarters_to_the_service() -> None:
    service = MagicMock()
    service.compare.return_value = comparison()
    deps = ToolDeps(
        search=MagicMock,
        market=MagicMock,
        history=MagicMock,
        resolver=MagicMock,
        comparison=lambda: service,
        ticker_record={"NVDA": indexed("NVDA")}.get,
    )
    mcp_server.set_tool_deps(lambda: deps)
    args = {
        "ticker": "NVDA",
        "focus": "margins",
        "prior_fiscal_year": 2026,
        "prior_fiscal_quarter": 4,
    }

    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool("compare_quarters", args)

    try:
        result = asyncio.run(call())
    finally:
        mcp_server.set_tool_deps(mcp_server.default_tool_deps)

    assert result.structured_content["status"] == "ok"
    service.compare.assert_called_once_with(
        "NVDA", current=None, prior=(2026, 4), focus="margins"
    )


def test_progress_label_and_summary() -> None:
    data = compare_quarters(
        make_deps(MagicMock(compare=MagicMock(return_value=comparison())))[0],
        turn(),
        ticker="NVDA",
    ).data

    assert tool_label("compare_quarters", {"ticker": "nvda"}) == (
        "Comparing NVDA earnings calls…"
    )
    assert tool_summary("compare_quarters", data, failed=False) == (
        "Compared Q2 FY2027 with Q1 FY2027 (4 passages)"
    )


def test_system_prompt_sets_the_comparison_rules() -> None:
    prompt = build_system_prompt(
        date(2026, 10, 4), advice_request=False, is_anonymous=False
    )

    assert "call compare_quarters once" in prompt
    headings = [
        '"### New"',
        '"### Raised / improved"',
        '"### Lowered / worse"',
        '"### No longer mentioned"',
        '"### Unchanged"',
    ]
    positions = [prompt.index(h) for h in headings]
    assert positions == sorted(positions)
    assert "using only the ones that have content" in prompt
    assert "nothing to report in the retrieved passages" in prompt
    assert "not discussed in the retrieved" in prompt
    assert "a change cites both" in prompt
    assert "Keep management's wording for forecasts" in prompt
