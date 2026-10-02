"""search_transcripts: recency, share-class mapping and waiting for indexing."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from app.models.rag import RagFilters, RagIndexingResponse, RagSearchResponse
from app.services.chat.transcripts import (
    SearchDeps,
    prioritize_recent,
    search_transcripts,
    transcript_ticker,
)
from app.services.rag.errors import SearchUpstreamError
from app.services.rag.repository import TickerRecord
from tests.chat_fakes import search_result, turn

TSLA_QUARTERS = ["FY2026Q2", "FY2026Q1", "FY2025Q4", "FY2025Q3"]


def result(i: int, fy: int, fq: int, score: float, ticker: str = "TSLA"):
    base = search_result(i, ticker=ticker)
    return base.model_copy(
        update={
            "id": f"{ticker}#FY{fy}Q{fq}#{i:04d}",
            "fiscal_year": fy,
            "fiscal_quarter": fq,
            "score": score,
        }
    )


def response(results) -> RagSearchResponse:
    return RagSearchResponse(
        query="q",
        filters=RagFilters(),
        reranked=True,
        candidate_count=len(results),
        results=results,
        latency_ms=1,
    )


def indexed(ticker: str, quarters=TSLA_QUARTERS, status="indexed") -> TickerRecord:
    return TickerRecord(
        ticker,
        status,
        f"{ticker} Inc",
        100,
        quarters,
        indexed_at=datetime(2026, 9, 30, tzinfo=UTC) if status == "indexed" else None,
    )


def make_deps(
    search, records=None, resolver=None, wait=45.0
) -> tuple[SearchDeps, list[float]]:
    clock = [0.0]
    records = records if records is not None else {"TSLA": indexed("TSLA")}

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    deps = SearchDeps(
        search=lambda: search,
        resolver=lambda: resolver or MagicMock(),
        ticker_record=lambda t: records.get(t) if not callable(records) else records(t),
        index_wait_seconds=wait,
        index_poll_seconds=2.0,
        sleep=sleep,
        clock=lambda: clock[0],
    )
    return deps, clock


# --- recency ----------------------------------------------------------------


def test_recency_boost_promotes_the_latest_call_and_orders_newest_first() -> None:
    quarters = {"TSLA": {(2026, 2): 0, (2026, 1): 1, (2025, 4): 2, (2025, 3): 3}}
    results = [
        result(1, 2025, 3, 0.80),
        result(2, 2025, 4, 0.78),
        result(3, 2026, 2, 0.70),  # latest call: +0.15 -> 0.85
        result(4, 2025, 3, 0.60),
    ]

    picked = prioritize_recent(results, 2, quarters)

    # 0.70+0.15 (latest) and 0.78+0.03 (two calls back) beat the older 0.80.
    assert [(r.fiscal_year, r.fiscal_quarter) for r in picked] == [(2026, 2), (2025, 4)]


def test_without_a_period_the_latest_call_is_always_represented() -> None:
    search = MagicMock()
    older = [result(i, 2025, 3, 0.9 - i / 100) for i in range(10)]
    latest = [result(50, 2026, 2, 0.4), result(51, 2026, 2, 0.35)]
    search.search.side_effect = [response(older), response(latest)]
    deps, _ = make_deps(search)

    out = search_transcripts(
        deps, turn(), query="Should I buy Tesla?", ticker="TSLA", top_k=5
    )

    first, top_up = (c.args[0] for c in search.search.call_args_list)
    assert first.top_k == 10 and first.fiscal_year is None
    assert (top_up.fiscal_year, top_up.fiscal_quarter, top_up.top_k) == (2026, 2, 2)
    periods = [(p["fiscal_year"], p["fiscal_quarter"]) for p in out.data["passages"]]
    assert len(periods) == 5
    assert periods[:2] == [(2026, 2), (2026, 2)]  # newest first
    assert "ordered newest call first" in out.text


def test_explicit_period_is_respected_without_recency_changes() -> None:
    search = MagicMock()
    search.search.return_value = response(
        [result(1, 2025, 3, 0.9), result(2, 2025, 3, 0.8)]
    )
    deps, _ = make_deps(search)

    out = search_transcripts(
        deps,
        turn(),
        query="q",
        ticker="TSLA",
        fiscal_year=2025,
        fiscal_quarter=3,
        top_k=5,
    )

    assert search.search.call_count == 1
    assert search.search.call_args.args[0].top_k == 5
    assert {p["fiscal_quarter"] for p in out.data["passages"]} == {3}


# --- share classes ------------------------------------------------------------


@pytest.mark.parametrize(
    ("asked", "records", "expected", "noted"),
    [
        ("GOOG", {"GOOGL": indexed("GOOGL")}, "GOOGL", True),
        ("GOOGL", {"GOOGL": indexed("GOOGL")}, "GOOGL", False),
        ("BRK.A", {"BRK.B": indexed("BRK.B")}, "BRK.B", True),
        ("GOOG", {}, "GOOGL", True),  # neither indexed: index the primary class
        ("goog", {"GOOG": indexed("GOOG")}, "GOOG", False),
        ("NVDA", {}, "NVDA", False),
    ],
)
def test_share_classes_map_to_the_indexed_class(
    asked, records, expected, noted
) -> None:
    ticker, note = transcript_ticker(asked, records.get)

    assert ticker == expected
    assert (note is not None) is noted


def test_search_for_goog_uses_googl_calls_without_asking() -> None:
    search = MagicMock()
    search.search.return_value = response([result(1, 2026, 2, 0.9, ticker="GOOGL")])
    records = {"GOOGL": indexed("GOOGL", ["FY2026Q2", "FY2026Q1"])}
    deps, _ = make_deps(search, records)

    out = search_transcripts(deps, turn(), query="cloud growth", ticker="GOOG")

    assert search.search.call_args_list[0].args[0].ticker == "GOOGL"
    assert out.data["ticker"] == "GOOGL"
    assert "share classes of the same company" in out.data["note"]


# --- waiting for on-demand indexing -------------------------------------------


def indexing(ticker: str = "SBUX") -> RagIndexingResponse:
    return RagIndexingResponse(
        ticker=ticker, job_id="j", message="m", poll_url=f"/rag/tickers/{ticker}"
    )


def resolver_for(name: str) -> MagicMock:
    resolver = MagicMock()
    resolver.resolve.return_value = MagicMock(ticker="SBUX", company_name=name)
    return resolver


def test_waits_for_indexing_then_answers_in_the_same_call() -> None:
    search = MagicMock()
    search.search.side_effect = [
        indexing(),
        response([result(1, 2026, 3, 0.9, ticker="SBUX")]),
    ]
    states = [
        indexed("SBUX", status="indexing"),
        indexed("SBUX", status="indexing"),
        indexed("SBUX", ["FY2026Q3"]),
    ]

    def poll(_ticker: str) -> TickerRecord:
        # Later reads (recency step) keep seeing the final, indexed state.
        return states.pop(0) if len(states) > 1 else states[0]

    deps, clock = make_deps(
        search, records=poll, resolver=resolver_for("STARBUCKS CORP")
    )
    progress: list[str] = []
    ctx = turn()
    ctx.progress = progress.append

    out = search_transcripts(deps, ctx, query="store traffic", ticker="SBUX")

    assert out.data["status"] == "ok" and len(out.data["passages"]) == 1
    assert progress == [
        "Indexing Starbucks transcripts…",
        "Searching SBUX transcripts…",
    ]
    assert clock[0] == 6.0  # three 2-second polls, well under the 45 s budget


def _indexing_label(deps, ctx) -> str:
    progress: list[str] = []
    ctx.progress = progress.append
    search_transcripts(deps, ctx, query="q", ticker="NKE")
    return progress[0]


def test_indexing_label_uses_the_name_resolve_company_found() -> None:
    search = MagicMock()
    search.search.return_value = indexing("NKE")
    resolver = MagicMock()
    resolver.resolve.return_value = MagicMock(ticker="NKE", company_name="NKE")
    deps, _ = make_deps(
        search, records=lambda _: indexed("NKE", status="indexing"), resolver=resolver
    )
    ctx = turn()
    ctx.company_names["NKE"] = "NIKE INC -CL B"

    assert _indexing_label(deps, ctx) == "Indexing Nike transcripts…"
    resolver.resolve.assert_not_called()


def test_indexing_label_never_mangles_a_bare_ticker() -> None:
    search = MagicMock()
    search.search.return_value = indexing("NKE")
    resolver = MagicMock()
    resolver.resolve.return_value = MagicMock(ticker="NKE", company_name="NKE")
    deps, _ = make_deps(
        search, records=lambda _: indexed("NKE", status="indexing"), resolver=resolver
    )

    assert _indexing_label(deps, turn()) == "Indexing NKE transcripts…"


def test_indexing_that_takes_too_long_falls_back_to_try_again() -> None:
    search = MagicMock()
    search.search.return_value = indexing()
    deps, clock = make_deps(
        search,
        records=lambda _: indexed("SBUX", status="indexing"),
        resolver=resolver_for("STARBUCKS CORP"),
    )

    out = search_transcripts(deps, turn(), query="q", ticker="SBUX")

    assert out.data["status"] == "indexing"
    assert "try again shortly" in out.data["message"]
    assert 45.0 <= clock[0] <= 47.0
    assert search.search.call_count == 1


def test_indexing_that_finds_no_transcripts_reports_unavailable() -> None:
    search = MagicMock()
    search.search.return_value = indexing()
    deps, _ = make_deps(search, records=lambda _: indexed("SBUX", status="unavailable"))

    out = search_transcripts(deps, turn(), query="q", ticker="SBUX")

    assert out.data["status"] == "unavailable"


# --- per-quarter search ("over the last year") ---------------------------------

MSFT_QUARTERS = ["FY2026Q4", "FY2026Q3", "FY2026Q2", "FY2026Q1"]


def quarter_search(by_quarter, reranked=True) -> MagicMock:
    search = MagicMock()
    search.ensure_indexed.return_value = None
    search.retrieve_by_quarter.return_value = (by_quarter, reranked)
    return search


def test_quarters_covers_every_quarter_not_just_the_top_matches() -> None:
    # A plain search for MSFT surfaced only Q2 and Q4; per-quarter search
    # gets passages from all four calls.
    by_quarter = {
        (2026, 4): [result(1, 2026, 4, 0.9, "MSFT"), result(2, 2026, 4, 0.8, "MSFT")],
        (2026, 3): [result(3, 2026, 3, 0.6, "MSFT")],
        (2026, 2): [result(4, 2026, 2, 0.85, "MSFT")],
        (2026, 1): [result(5, 2026, 1, 0.4, "MSFT")],
    }
    search = quarter_search(by_quarter)
    deps, _ = make_deps(search, records={"MSFT": indexed("MSFT", MSFT_QUARTERS)})

    out = search_transcripts(
        deps, turn(), query="Azure growth", ticker="MSFT", quarters=4
    )

    search.retrieve_by_quarter.assert_called_once_with(
        "Azure growth",
        "MSFT",
        [(2026, 4), (2026, 3), (2026, 2), (2026, 1)],
        2,
    )
    search.search.assert_not_called()
    coverage = [(c["fiscal_year"], c["fiscal_quarter"]) for c in out.data["coverage"]]
    assert coverage == [(2026, 4), (2026, 3), (2026, 2), (2026, 1)]
    assert all(c["passages"] for c in out.data["coverage"])
    assert out.data["quarters_searched"] == 4
    assert [p["id"] for p in out.data["passages"]] == [1, 2, 3, 4, 5]
    text = out.text
    for heading in ("### Q4 FY2026", "### Q3 FY2026", "### Q2 FY2026", "### Q1 FY2026"):
        assert heading in text
    assert text.index("### Q4 FY2026") < text.index("### Q1 FY2026")  # newest first
    assert "Cover every quarter below" in text
    assert "NO RELEVANT PASSAGES" in text  # the instruction, even with none missing
    assert "Quarters with nothing relevant" not in text


def test_quarters_reports_a_quarter_with_nothing_relevant_explicitly() -> None:
    by_quarter = {
        (2026, 4): [result(1, 2026, 4, 0.9, "MSFT")],
        (2026, 3): [],  # nothing retrieved
        (2026, 2): [result(2, 2026, 2, 0.01, "MSFT")],  # below relevance floor
        (2026, 1): [result(3, 2026, 1, 0.5, "MSFT")],
    }
    deps, _ = make_deps(
        quarter_search(by_quarter), records={"MSFT": indexed("MSFT", MSFT_QUARTERS)}
    )

    out = search_transcripts(deps, turn(), query="layoffs", ticker="MSFT", quarters=4)

    empty = [
        (c["fiscal_year"], c["fiscal_quarter"])
        for c in out.data["coverage"]
        if not c["passages"]
    ]
    assert empty == [(2026, 3), (2026, 2)]
    q3 = out.text.split("### Q3 FY2026")[1].split("###")[0]
    assert "NO RELEVANT PASSAGES: this call did not discuss the topic." in q3
    assert "Quarters with nothing relevant: 2." in out.text
    assert out.data["status"] == "ok"


def test_quarters_keeps_low_scores_when_not_reranked() -> None:
    by_quarter = {(2026, 4): [result(1, 2026, 4, 0.01, "MSFT")]}
    deps, _ = make_deps(
        quarter_search(by_quarter, reranked=False),
        records={"MSFT": indexed("MSFT", MSFT_QUARTERS)},
    )

    out = search_transcripts(deps, turn(), query="q", ticker="MSFT", quarters=1)

    assert len(out.data["passages"]) == 1
    assert out.data["coverage"] == [
        {"fiscal_year": 2026, "fiscal_quarter": 4, "passages": [1]}
    ]


def test_quarters_notes_when_fewer_quarters_are_indexed() -> None:
    search = quarter_search({(2026, 4): [result(1, 2026, 4, 0.9, "MSFT")]})
    deps, _ = make_deps(search, records={"MSFT": indexed("MSFT", ["FY2026Q4"])})

    out = search_transcripts(deps, turn(), query="q", ticker="MSFT", quarters=4)

    assert search.retrieve_by_quarter.call_args.args[2] == [(2026, 4)]
    assert search.retrieve_by_quarter.call_args.args[3] == 4  # more per quarter
    assert "Only 1 quarter(s) are indexed for MSFT" in out.data["note"]


def test_quarters_waits_for_indexing_before_searching() -> None:
    search = quarter_search({(2026, 3): [result(1, 2026, 3, 0.9, "SBUX")]})
    search.ensure_indexed.return_value = indexing()
    states = [indexed("SBUX", status="indexing"), indexed("SBUX", ["FY2026Q3"])]
    deps, _ = make_deps(
        search,
        records=lambda _: states.pop(0) if len(states) > 1 else states[0],
        resolver=resolver_for("STARBUCKS CORP"),
    )

    out = search_transcripts(deps, turn(), query="traffic", ticker="SBUX", quarters=4)

    assert out.data["status"] == "ok"
    search.retrieve_by_quarter.assert_called_once()


def test_quarters_relays_search_outages() -> None:
    search = quarter_search({})
    search.retrieve_by_quarter.side_effect = SearchUpstreamError("down")
    deps, _ = make_deps(search, records={"MSFT": indexed("MSFT", MSFT_QUARTERS)})

    out = search_transcripts(deps, turn(), query="q", ticker="MSFT", quarters=4)

    assert out.data["status"] == "error"


def test_quarters_without_a_ticker_runs_a_normal_search() -> None:
    search = MagicMock()
    search.search.return_value = response([result(1, 2026, 2, 0.9)])
    deps, _ = make_deps(search)

    search_transcripts(deps, turn(), query="AI capex", quarters=4)

    search.search.assert_called_once()
    search.retrieve_by_quarter.assert_not_called()
