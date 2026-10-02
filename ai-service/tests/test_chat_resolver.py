"""Tests for company and fiscal-period resolution."""

import pytest

from app.services.chat.resolver import CompanyResolver, normalize_name, resolve_period
from app.services.rag.repository import TickerRecord

INDEXED = [
    TickerRecord(
        "AAPL",
        "indexed",
        "Apple Inc.",
        269,
        ["FY2026Q3", "FY2026Q2", "FY2026Q1", "FY2025Q4"],
    ),
    TickerRecord("GOOGL", "indexed", "Alphabet Inc.", 209, ["FY2026Q2", "FY2026Q1"]),
    TickerRecord("COST", "indexed", "Costco Wholesale Corp", 277, ["FY2026Q3"]),
]


def make_resolver(search_results=None, calls=None):
    def search(query):
        if calls is not None:
            calls.append(query)
        return search_results or []

    return CompanyResolver(lambda: INDEXED, search)


def test_normalize_name_strips_suffixes() -> None:
    assert normalize_name("Apple Inc.") == "apple"
    assert normalize_name("The Coca-Cola Company") == "coca cola"


def test_indexed_name_resolves_without_external_search() -> None:
    calls: list[str] = []

    result = make_resolver(calls=calls).resolve("apple", period="last quarter")

    assert result.status == "resolved" and result.ticker == "AAPL"
    assert result.indexed is True
    assert result.period == {
        "fiscal_year": 2026,
        "fiscal_quarter": 3,
        "basis": "indexed",
        "note": "latest reported quarter is Q3 FY2026 (company fiscal calendar)",
    }
    assert calls == []


def test_ticker_input_resolves_directly_even_lowercase() -> None:
    assert make_resolver().resolve("GOOGL").ticker == "GOOGL"
    assert make_resolver().resolve("cost").ticker == "COST"


def test_share_classes_are_ambiguous() -> None:
    result = make_resolver().resolve("Alphabet")

    assert result.status == "ambiguous"
    assert [c.ticker for c in result.candidates] == ["GOOGL", "GOOG"]
    assert "Ask the user" in result.message


def test_several_similar_companies_are_ambiguous() -> None:
    hits = [
        {"symbol": "DAL", "description": "DELTA AIR LINES INC"},
        {"symbol": "DLA", "description": "DELTA APPAREL INC"},
    ]

    result = make_resolver(hits).resolve("Delta")

    assert result.status == "ambiguous"
    assert {c.ticker for c in result.candidates} == {"DAL", "DLA"}


def test_exact_name_beats_prefix_matches() -> None:
    hits = [
        {"symbol": "SBUX", "description": "STARBUCKS CORP"},
        {"symbol": "SBX", "description": "STARBUCKS COFFEE HOLDINGS LTD"},
    ]

    result = make_resolver(hits).resolve("Starbucks")

    assert result.status == "resolved" and result.ticker == "SBUX"
    assert result.indexed is False


def test_unknown_company_is_not_found() -> None:
    result = make_resolver([]).resolve("Totally Made Up Widgets")

    assert result.status == "not_found"


def test_search_failures_degrade_to_not_found() -> None:
    def broken(_):
        raise RuntimeError("finnhub down")

    result = CompanyResolver(lambda: INDEXED, broken).resolve("Starbucks")

    assert result.status == "not_found"


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("most recent quarter", (2026, 3)),
        ("the previous quarter", (2026, 2)),
        ("two quarters ago", (2026, 2)),
        ("three quarters ago", (2026, 1)),
        ("same quarter last year", (2025, 3)),
        ("Q2 2025", (2025, 2)),
        ("Q4 FY25", (2025, 4)),
        ("fiscal 2024 q1", (2024, 1)),
    ],
)
def test_resolve_period(phrase, expected) -> None:
    period = resolve_period(phrase, ["FY2026Q3", "FY2026Q2", "FY2026Q1"])

    assert (period["fiscal_year"], period["fiscal_quarter"]) == expected


def test_relative_period_without_index_explains_itself() -> None:
    period = resolve_period("last quarter", [])

    assert period["basis"] == "unknown" and "indexed" in period["note"]
    assert resolve_period("tell me about revenue", ["FY2026Q3"]) is None
