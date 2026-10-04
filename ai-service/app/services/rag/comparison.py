"""Quarter-over-quarter comparison of one company's earnings calls.

For a fixed set of themes (plus an optional user focus), passages are
retrieved separately for each of the two quarters, so neither quarter nor any
theme crowds out another, and returned grouped by theme and quarter. Each
quarter costs exactly one rerank call (two per comparison; Pinecone Starter
allows 500 a month), and repeats within the cache TTL cost none.

The service knows nothing about chat or citations, so other consumers (e.g. a
multi-agent report) can use it directly.
"""

import logging
from dataclasses import dataclass

from app.models.comparison import (
    ComparisonStatus,
    FiscalPeriod,
    QuarterComparison,
    ThemePassages,
)
from app.models.rag import RagSearchResult
from app.models.transcript import parse_period_label, period_label

from .repository import RagRepository
from .search import RagSearchService

logger = logging.getLogger(__name__)

Period = tuple[int, int]


@dataclass(frozen=True)
class Theme:
    key: str
    label: str
    # No company name: the vector filter scopes the ticker, and generic
    # queries hit the embedding caches for every ticker and quarter.
    query: str


THEMES: tuple[Theme, ...] = (
    Theme(
        "guidance",
        "Guidance and outlook",
        "guidance and outlook for the next quarter and full year, forecasts and "
        "expectations",
    ),
    Theme(
        "demand",
        "Demand and growth drivers",
        "customer demand, revenue growth drivers, orders, bookings and pipeline",
    ),
    Theme(
        "margins",
        "Margins and costs",
        "gross and operating margins, pricing, costs, expenses and efficiency",
    ),
    Theme(
        "capital",
        "Capital allocation",
        "capital expenditures, share buybacks, dividends, acquisitions and "
        "investment plans",
    ),
    Theme(
        "risks",
        "Risks and headwinds",
        "risks, headwinds, challenges, uncertainty, supply constraints, tariffs "
        "and regulation",
    ),
    Theme(
        "initiatives",
        "New initiatives",
        "new products, launches, partnerships, new markets and strategic "
        "initiatives",
    ),
)
FOCUS_KEY = "focus"
# Candidates per theme per quarter: 7 themes x 6 stays far below the
# reranker's 100-document limit.
CANDIDATES_PER_THEME = 6
# Passages kept per theme per quarter (with a focus: the focus gets more and
# the fixed themes fewer, keeping the tool output about the same size).
PASSAGES_PER_THEME = 2
FOCUS_PASSAGES = 3
PASSAGES_PER_THEME_WITH_FOCUS = 1
# No absolute relevance cut. Scored against one composite query (one rerank
# call per quarter), bge-reranker-v2-m3 gives every passage a low score: on
# NVDA's FY2027 Q1/Q2 calls the best of 17-21 candidates scored 0.011-0.044,
# so the 0.02 cut used for single-topic searches would drop substantive
# passages. The rerank order within each theme plus the per-theme limits keep
# the strongest passages and push boilerplate out instead.
MIN_RELEVANCE = 0.0
MAX_FOCUS_CHARS = 200


class QuarterSelectionError(Exception):
    """The requested quarters can't be compared; ``status`` says why."""

    def __init__(self, status: ComparisonStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class QuarterSelection:
    current: Period
    prior: Period
    note: str | None = None


def _label(period: Period) -> str:
    return period_label(*period)


def _next_quarter(period: Period) -> Period:
    year, quarter = period
    return (year + 1, 1) if quarter == 4 else (year, quarter + 1)


def select_quarters(
    ticker: str,
    indexed: list[Period],
    current: Period | None = None,
    prior: Period | None = None,
) -> QuarterSelection:
    """Pick the two quarters to compare from the indexed ones (newest first).

    Defaults to the latest indexed quarter vs the one before it. With only
    ``current``, its prior is the indexed quarter before it; with only
    ``prior``, it is compared with the latest. Raises
    :class:`QuarterSelectionError` when there is nothing valid to compare.
    """
    if len(indexed) < 2:
        only = f"Only {_label(indexed[0])} is" if indexed else "No quarter is"
        raise QuarterSelectionError(
            "not_enough_quarters",
            f"{only} indexed for {ticker}, so there is no earlier call to "
            "compare it with.",
        )
    missing = [p for p in (current, prior) if p is not None and p not in indexed]
    if missing:
        listed = ", ".join(_label(p) for p in indexed)
        raise QuarterSelectionError(
            "quarter_not_indexed",
            f"{' and '.join(_label(p) for p in missing)} "
            f"{'is' if len(missing) == 1 else 'are'} not indexed for {ticker}. "
            f"Indexed quarters: {listed}.",
        )
    if current is not None and current == prior:
        raise QuarterSelectionError(
            "invalid_quarters", "Choose two different quarters to compare."
        )

    if current is not None and prior is not None:
        newer, older = max(current, prior), min(current, prior)
        return QuarterSelection(newer, older)
    if prior is not None:
        newer = indexed[0]
        if newer <= prior:
            raise QuarterSelectionError(
                "not_enough_quarters",
                f"{_label(prior)} is the latest indexed quarter for {ticker}; "
                "there is no later call to compare it with.",
            )
        return QuarterSelection(newer, prior)

    newer = current if current is not None else indexed[0]
    earlier = [p for p in indexed if p < newer]
    if not earlier:
        raise QuarterSelectionError(
            "not_enough_quarters",
            f"{_label(newer)} is the earliest indexed quarter for {ticker}; "
            "there is no earlier call to compare it with.",
        )
    older = earlier[0]
    note = None
    if _next_quarter(older) != newer:
        note = (
            f"The call before {_label(newer)} isn't indexed, so it is compared "
            f"with {_label(older)}, the previous indexed call."
        )
    return QuarterSelection(newer, older, note)


class QuarterComparisonService:
    def __init__(self, repo: RagRepository, search: RagSearchService) -> None:
        self._repo = repo
        self._search = search

    def compare(
        self,
        ticker: str,
        *,
        current: Period | None = None,
        prior: Period | None = None,
        focus: str | None = None,
    ) -> QuarterComparison:
        """Compare two quarters of ``ticker``'s calls, theme by theme.

        A ticker that isn't indexed yet starts on-demand indexing and comes
        back as ``indexing`` (raising like search does when it can't be
        indexed at all).
        """
        ticker = ticker.strip().upper()
        focus = (focus or "").strip()[:MAX_FOCUS_CHARS] or None
        pending = self._search.ensure_indexed(ticker)
        if pending is not None:
            return QuarterComparison(
                status="indexing", ticker=ticker, message=pending.message
            )

        record = self._repo.get_ticker(ticker)
        labels = record.quarters if record else []
        indexed = sorted(
            {p for label in labels if (p := parse_period_label(label))},
            reverse=True,
        )
        available = [_label(p) for p in indexed]
        try:
            selection = select_quarters(ticker, indexed, current, prior)
        except QuarterSelectionError as exc:
            return QuarterComparison(
                status=exc.status,
                ticker=ticker,
                company_name=record.company_name if record else None,
                available_quarters=available,
                message=exc.message,
            )

        themes = _themes(focus)
        queries = [(key, query) for key, _, query, _ in themes]
        rerank_query = _rerank_query(focus)
        newer, current_reranked = self._retrieve(
            ticker, selection.current, queries, rerank_query
        )
        older, prior_reranked = self._retrieve(
            ticker, selection.prior, queries, rerank_query
        )
        return QuarterComparison(
            status="ok",
            ticker=ticker,
            company_name=record.company_name if record else None,
            current=FiscalPeriod(
                fiscal_year=selection.current[0], fiscal_quarter=selection.current[1]
            ),
            prior=FiscalPeriod(
                fiscal_year=selection.prior[0], fiscal_quarter=selection.prior[1]
            ),
            focus=focus,
            reranked=current_reranked and prior_reranked,
            themes=[
                ThemePassages(
                    key=key,
                    label=label,
                    current=newer[key][:limit],
                    prior=older[key][:limit],
                )
                for key, label, _, limit in themes
            ],
            available_quarters=available,
            note=selection.note,
        )

    def _retrieve(
        self,
        ticker: str,
        period: Period,
        queries: list[tuple[str, str]],
        rerank_query: str,
    ) -> tuple[dict[str, list[RagSearchResult]], bool]:
        return self._search.retrieve_themes(
            ticker,
            period,
            queries,
            rerank_query=rerank_query,
            candidates_per_theme=CANDIDATES_PER_THEME,
            min_score=MIN_RELEVANCE,
        )


def _themes(focus: str | None) -> list[tuple[str, str, str, int]]:
    """(key, label, query, passages kept) in priority order, focus first."""
    if focus is None:
        return [(t.key, t.label, t.query, PASSAGES_PER_THEME) for t in THEMES]
    return [
        (FOCUS_KEY, f"Focus: {focus}", focus, FOCUS_PASSAGES),
        *((t.key, t.label, t.query, PASSAGES_PER_THEME_WITH_FOCUS) for t in THEMES),
    ]


def _rerank_query(focus: str | None) -> str:
    topics = "; ".join(t.label.lower() for t in THEMES)
    query = f"What management said about {topics}"
    return f"{query}; especially {focus}" if focus else query
