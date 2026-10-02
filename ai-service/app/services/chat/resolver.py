"""Resolve company names to tickers and relative periods to fiscal quarters.

Deterministic on purpose: the model asks, this module answers, and when a name
matches several listings (share classes, similarly named companies) it returns
``ambiguous`` so the agent asks the user instead of guessing.
"""

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from app.services.rag.repository import TickerRecord

logger = logging.getLogger(__name__)

_TICKER_RE = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z])?$")
_SUFFIX_RE = re.compile(
    r"\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|"
    r"group|the|class [abc]|com|sa|nv|ag|se)\b"
)
# Colloquial names that map to more than one listing or aren't in the index.
_ALIASES: dict[str, list[str]] = {
    "google": ["GOOGL", "GOOG"],
    "alphabet": ["GOOGL", "GOOG"],
    "berkshire": ["BRK.B", "BRK.A"],
    "berkshire hathaway": ["BRK.B", "BRK.A"],
    "facebook": ["META"],
    "meta": ["META"],
    "amazon": ["AMZN"],
    "nvidia": ["NVDA"],
    "microsoft": ["MSFT"],
    "tesla": ["TSLA"],
    "netflix": ["NFLX"],
    "costco": ["COST"],
    "jpmorgan": ["JPM"],
    "jp morgan": ["JPM"],
    "chase": ["JPM"],
}
_SHARE_CLASS_NOTES = {
    "GOOGL": "Alphabet Class A (voting)",
    "GOOG": "Alphabet Class C (non-voting)",
    "BRK.A": "Berkshire Hathaway Class A",
    "BRK.B": "Berkshire Hathaway Class B",
}

SymbolSearch = Callable[[str], list[dict[str, Any]]]
IndexedTickers = Callable[[], list[TickerRecord]]


def normalize_name(name: str) -> str:
    text = re.sub(r"[^a-z0-9 ]+", " ", name.lower().replace("&", " and "))
    text = _SUFFIX_RE.sub(" ", text)
    return " ".join(text.split())


@dataclass
class Candidate:
    ticker: str
    name: str
    note: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out = {"ticker": self.ticker, "name": self.name}
        if self.note:
            out["note"] = self.note
        return out


@dataclass
class Resolution:
    status: Literal["resolved", "ambiguous", "not_found"]
    query: str
    ticker: str | None = None
    company_name: str | None = None
    candidates: list[Candidate] = field(default_factory=list)
    indexed: bool = False
    period: dict[str, Any] | None = None
    message: str | None = None
    share_classes: list[Candidate] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status, "query": self.query}
        if self.ticker:
            out.update(
                ticker=self.ticker,
                company_name=self.company_name,
                transcripts_indexed=self.indexed,
            )
        if self.candidates:
            out["candidates"] = [c.as_dict() for c in self.candidates]
        if self.share_classes:
            out["share_classes"] = [c.as_dict() for c in self.share_classes]
        if self.period:
            out["period"] = self.period
        if self.message:
            out["message"] = self.message
        return out


# --- Periods ----------------------------------------------------------------

_QUARTER_RE = re.compile(r"FY(\d{4})Q([1-4])")
_RELATIVE: list[tuple[re.Pattern[str], int]] = [
    (re.compile(r"\b(three|3) quarters ago\b"), 2),
    (
        re.compile(
            r"\b(previous|prior) quarter\b|\bquarter before last\b"
            r"|\b(two|2) quarters ago\b"
        ),
        1,
    ),
    (re.compile(r"\b(last|latest|most recent|recent|this|current|past) quarter\b"), 0),
]
_YEAR_AGO_RE = re.compile(
    r"\b(same|this) quarter (last|a|one) year\b|\byear[- ]ago quarter\b"
)
_EXPLICIT_RES = [
    re.compile(r"\bq([1-4])\s*(?:of\s*)?(?:fy|fiscal)?\s*'?(\d{4}|\d{2})\b"),
    re.compile(r"\b(?:fy|fiscal(?: year)?)\s*'?(\d{4}|\d{2})\s*q([1-4])\b"),
]


def _year(raw: str) -> int:
    value = int(raw)
    return value + 2000 if value < 100 else value


def _parse_quarter_label(label: str) -> tuple[int, int] | None:
    match = _QUARTER_RE.fullmatch(label)
    return (int(match.group(1)), int(match.group(2))) if match else None


def resolve_period(text: str, quarters: list[str]) -> dict[str, Any] | None:
    """Map a period phrase to (fiscal_year, fiscal_quarter).

    ``quarters`` are the ticker's indexed quarters, newest first
    (e.g. ["FY2026Q3", "FY2026Q2"]). Explicit periods are parsed as given;
    relative ones need the indexed fiscal calendar.
    """
    lowered = text.lower()
    for pattern in _EXPLICIT_RES:
        match = pattern.search(lowered)
        if match:
            groups = match.groups()
            if pattern is _EXPLICIT_RES[0]:
                quarter, year = int(groups[0]), _year(groups[1])
            else:
                year, quarter = _year(groups[0]), int(groups[1])
            return {"fiscal_year": year, "fiscal_quarter": quarter, "basis": "explicit"}

    parsed = [q for q in (_parse_quarter_label(label) for label in quarters) if q]
    wants_year_ago = bool(_YEAR_AGO_RE.search(lowered))
    offset = next((o for pattern, o in _RELATIVE if pattern.search(lowered)), None)
    if offset is None and not wants_year_ago:
        return None
    if not parsed:
        return {
            "basis": "unknown",
            "note": "This company's fiscal calendar is unknown until its transcripts "
            "are indexed; search without a period filter or retry after indexing.",
        }
    if wants_year_ago:
        year, quarter = parsed[0]
        return {
            "fiscal_year": year - 1,
            "fiscal_quarter": quarter,
            "basis": "indexed",
            "note": "same fiscal quarter one year before the latest reported quarter",
        }
    if offset is not None and offset < len(parsed):
        year, quarter = parsed[offset]
        return {
            "fiscal_year": year,
            "fiscal_quarter": quarter,
            "basis": "indexed",
            "note": f"latest reported quarter is Q{parsed[0][1]} FY{parsed[0][0]} "
            "(company fiscal calendar)",
        }
    return {"basis": "unknown", "note": "that quarter is not among the indexed calls"}


# --- Companies ----------------------------------------------------------------


class CompanyResolver:
    def __init__(
        self, indexed_tickers: IndexedTickers, symbol_search: SymbolSearch
    ) -> None:
        self._indexed_tickers = indexed_tickers
        self._symbol_search = symbol_search

    def resolve(self, query: str, period: str | None = None) -> Resolution:
        query = query.strip()
        indexed = self._safe_indexed()
        by_ticker = {r.ticker: r for r in indexed}
        resolution = self._resolve_company(query, indexed, by_ticker)
        if resolution.status == "resolved" and resolution.ticker:
            record = by_ticker.get(resolution.ticker)
            resolution.indexed = bool(record and record.status == "indexed")
            if period:
                resolution.period = resolve_period(
                    period, record.quarters if record else []
                )
        return resolution

    def _resolve_company(
        self,
        query: str,
        indexed: list[TickerRecord],
        by_ticker: dict[str, TickerRecord],
    ) -> Resolution:
        upper = query.upper()
        record = by_ticker.get(upper)
        if record and normalize_name(query) not in _ALIASES:
            return Resolution("resolved", query, upper, record.company_name or upper)
        if _TICKER_RE.match(upper) and query == upper:
            match = next(
                (r for r in self._safe_search(upper) if r["symbol"] == upper), None
            )
            if match:
                return Resolution("resolved", query, upper, match["description"])

        norm = normalize_name(query)
        if not norm:
            return Resolution("not_found", query, message="empty company name")

        alias = _ALIASES.get(norm)
        if alias:
            names = {r.ticker: r.company_name for r in indexed}
            candidates = [
                Candidate(
                    t,
                    names.get(t) or _SHARE_CLASS_NOTES.get(t, t),
                    _SHARE_CLASS_NOTES.get(t),
                )
                for t in alias
            ]
            if len(candidates) == 1:
                c = candidates[0]
                return Resolution("resolved", query, c.ticker, c.name)
            # Share classes of one company: resolve to the indexed (or primary)
            # class for company-level questions; list the classes so the agent
            # can ask only when the class matters (prices).
            primary = next((c for c in candidates if c.ticker in names), candidates[0])
            return Resolution(
                "resolved",
                query,
                primary.ticker,
                names.get(primary.ticker) or primary.name,
                share_classes=candidates,
                message=(
                    f"{' and '.join(c.ticker for c in candidates)} are share classes "
                    f"of one company with the same earnings calls; use "
                    f"{primary.ticker} for transcripts and company questions. Only "
                    "for prices or quotes, ask which class unless the user named one."
                ),
            )

        exact = [
            r
            for r in indexed
            if r.company_name and normalize_name(r.company_name) == norm
        ]
        if len(exact) == 1:
            return Resolution("resolved", query, exact[0].ticker, exact[0].company_name)

        results = self._safe_search(query)
        exact_hits = [r for r in results if normalize_name(r["description"]) == norm]
        if len(exact_hits) == 1:
            hit = exact_hits[0]
            return Resolution("resolved", query, hit["symbol"], hit["description"])
        prefix_hits = exact_hits or [
            r for r in results if normalize_name(r["description"]).startswith(norm)
        ]
        if len(prefix_hits) == 1:
            hit = prefix_hits[0]
            return Resolution("resolved", query, hit["symbol"], hit["description"])
        if prefix_hits:
            return self._ambiguous(
                query,
                [Candidate(r["symbol"], r["description"]) for r in prefix_hits[:5]],
            )
        return Resolution(
            "not_found",
            query,
            message="No US-listed company matched; ask the user for the ticker.",
        )

    @staticmethod
    def _ambiguous(query: str, candidates: list[Candidate]) -> Resolution:
        return Resolution(
            "ambiguous",
            query,
            candidates=candidates,
            message="Several listings match. Ask the user which one they mean "
            "before calling other tools.",
        )

    def _safe_indexed(self) -> list[TickerRecord]:
        try:
            return self._indexed_tickers()
        except Exception:
            logger.warning(
                "could not load indexed tickers for resolution", exc_info=True
            )
            return []

    def _safe_search(self, query: str) -> list[dict[str, Any]]:
        try:
            return self._symbol_search(query)
        except Exception:
            logger.warning("symbol search failed for %r", query, exc_info=True)
            return []


def finnhub_symbol_search(api_key: str, base_url: str, timeout: float) -> SymbolSearch:
    """Finnhub /search, filtered to US common stock."""

    def search(query: str) -> list[dict[str, Any]]:
        if not api_key:
            return []
        response = httpx.get(
            f"{base_url.rstrip('/')}/search",
            params={"q": query, "exchange": "US"},
            headers={"X-Finnhub-Token": api_key},  # keep the key out of URLs
            timeout=timeout,
        )
        response.raise_for_status()
        results = response.json().get("result", [])
        return [
            {"symbol": r["symbol"], "description": r.get("description") or r["symbol"]}
            for r in results
            if r.get("type") == "Common Stock" and r.get("symbol")
        ]

    return search
