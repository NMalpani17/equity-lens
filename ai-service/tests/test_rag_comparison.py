"""Quarter comparison: quarter selection, theme retrieval and the rerank budget."""

from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from app.services.rag.cache import TTLCache
from app.services.rag.comparison import (
    CANDIDATES_PER_THEME,
    THEMES,
    QuarterComparisonService,
    QuarterSelectionError,
    select_quarters,
)
from app.services.rag.errors import RerankUnavailableError
from app.services.rag.jobs import IngestionCoordinator
from app.services.rag.repository import TickerRecord, utcnow
from app.services.rag.reranker import RerankedItem
from app.services.rag.search import RagSearchService
from app.services.rag.vector_store import SearchHit
from tests.rag_fakes import FakeEmbedder, FakeRepo, FakeSparse, InlineExecutor

NVDA_QUARTERS = ["FY2027Q2", "FY2027Q1", "FY2026Q4", "FY2026Q3"]
GUIDANCE, DEMAND, MARGINS = (THEMES[0].query, THEMES[1].query, THEMES[2].query)


# --- quarter selection ------------------------------------------------------------

INDEXED = [(2027, 2), (2027, 1), (2026, 4), (2026, 3)]


@pytest.mark.parametrize(
    ("current", "prior", "expected"),
    [
        (None, None, ((2027, 2), (2027, 1))),  # latest vs the one before
        ((2027, 1), None, ((2027, 1), (2026, 4))),  # crosses a fiscal year
        ((2026, 4), (2027, 2), ((2027, 2), (2026, 4))),  # reversed: swapped
        (None, (2026, 3), ((2027, 2), (2026, 3))),  # prior only: vs latest
    ],
)
def test_select_quarters(current, prior, expected) -> None:
    selection = select_quarters("NVDA", INDEXED, current, prior)

    assert (selection.current, selection.prior) == expected
    assert selection.note is None


def test_a_skipped_quarter_is_noted() -> None:
    selection = select_quarters("NVDA", [(2027, 2), (2026, 4)])

    assert (selection.current, selection.prior) == ((2027, 2), (2026, 4))
    assert "FY2026Q4, the previous indexed call" in selection.note


@pytest.mark.parametrize(
    ("indexed", "current", "prior", "status", "message"),
    [
        ([(2027, 2)], None, None, "not_enough_quarters", "Only FY2027Q2 is indexed"),
        ([], None, None, "not_enough_quarters", "No quarter is indexed"),
        (INDEXED, (2026, 3), None, "not_enough_quarters", "earliest indexed"),
        (INDEXED, None, (2027, 2), "not_enough_quarters", "no later call"),
        (INDEXED, (2025, 1), None, "quarter_not_indexed", "FY2025Q1 is not indexed"),
        (INDEXED, (2027, 2), (2027, 2), "invalid_quarters", "two different"),
    ],
)
def test_select_quarters_refusals(indexed, current, prior, status, message) -> None:
    with pytest.raises(QuarterSelectionError) as info:
        select_quarters("NVDA", indexed, current, prior)

    assert info.value.status == status
    assert message in info.value.message


def test_quarter_not_indexed_lists_what_is() -> None:
    with pytest.raises(QuarterSelectionError) as info:
        select_quarters("NVDA", INDEXED, (2025, 1), (2024, 4))

    assert "FY2025Q1 and FY2024Q4 are not indexed" in info.value.message
    assert "Indexed quarters: FY2027Q2, FY2027Q1, FY2026Q4, FY2026Q3." in str(
        info.value
    )


# --- retrieval and the rerank budget ------------------------------------------------


def hit(chunk: str, period: tuple[int, int], score: float = 0.5) -> SearchHit:
    year, quarter = period
    return SearchHit(
        id=f"NVDA#FY{year}Q{quarter}#{chunk}",
        score=score,
        metadata={
            "ticker": "NVDA",
            "company_name": "Nvidia Corp",
            "fiscal_year": float(year),
            "fiscal_quarter": float(quarter),
            "call_date": "2026-08-26",
            "speaker": "Colette Kress",
            "role": "CFO",
            "section": "prepared_remarks",
            "chunk_index": 1.0,
            "context_header": "NVDA (Nvidia Corp)",
            "text": f"passage {chunk} of FY{year}Q{quarter}",
        },
    )


class ThemeStore:
    """Returns configured hits per (theme query, quarter); records each query."""

    def __init__(self, embedder: FakeEmbedder) -> None:
        self.embedder = embedder
        self.hits: dict[tuple[str, tuple[int, int]], list[SearchHit]] = {}
        self.queries: list[tuple[str, tuple[int, int], int]] = []

    def query(self, *, metadata_filter, top_k, **_) -> list[SearchHit]:
        period = (
            metadata_filter["fiscal_year"]["$eq"],
            metadata_filter["fiscal_quarter"]["$eq"],
        )
        assert metadata_filter["ticker"] == {"$eq": "NVDA"}
        query = self.embedder.queries[-1]
        self.queries.append((query, period, top_k))
        return self.hits.get((query, period), [])[:top_k]


def rerank_in_order(query, documents, top_n):
    """Scores documents in the order given (first = most relevant)."""
    return [RerankedItem(i, 0.9 - i / 100) for i in range(len(documents))][:top_n]


def make_service(*, quarters=NVDA_QUARTERS, reranker: MagicMock | None = None):
    repo = FakeRepo()
    repo.tickers["NVDA"] = TickerRecord(
        "NVDA", "indexed", "Nvidia Corp", 300, quarters, indexed_at=utcnow()
    )
    embedder = FakeEmbedder()
    store = ThemeStore(embedder)
    if reranker is None:
        reranker = MagicMock()
        reranker.rerank.side_effect = rerank_in_order
    coordinator = IngestionCoordinator(
        repo,
        MagicMock(),
        InlineExecutor(run=False),
        daily_cap=8,
        stale_after=timedelta(minutes=30),
    )
    search = RagSearchService(
        repo,
        coordinator,
        embedder,
        FakeSparse(),
        store,
        reranker,
        rerank_cache=TTLCache(10, 60),
        namespace="ctx",
        candidate_k=25,
        alpha=0.75,
    )
    return QuarterComparisonService(repo, search), store, reranker, repo


Q2, Q1 = (2027, 2), (2027, 1)


def test_each_quarter_gets_its_own_theme_queries_and_one_rerank_call() -> None:
    service, store, reranker, _ = make_service()
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2), hit("g2", Q2), hit("g3", Q2)]
    store.hits[(GUIDANCE, Q1)] = [hit("g1", Q1)]

    result = service.compare("nvda")

    assert result.status == "ok"
    assert (result.current.label, result.prior.label) == ("FY2027Q2", "FY2027Q1")
    # Every theme is searched once per quarter, each with its own candidates.
    assert len(store.queries) == 2 * len(THEMES)
    assert {top_k for *_, top_k in store.queries} == {CANDIDATES_PER_THEME}
    assert reranker.rerank.call_count == 2  # one per quarter
    guidance = result.themes[0]
    assert [p.id for p in guidance.current] == ["NVDA#FY2027Q2#g1", "NVDA#FY2027Q2#g2"]
    assert [p.id for p in guidance.prior] == ["NVDA#FY2027Q1#g1"]
    assert all(p.fiscal_quarter == 2 for p in guidance.current)  # no quarter mixing


def test_a_repeated_comparison_reuses_the_rerank_cache() -> None:
    service, store, reranker, _ = make_service()
    store.hits[(DEMAND, Q2)] = [hit("d1", Q2)]
    store.hits[(DEMAND, Q1)] = [hit("d1", Q1)]

    service.compare("NVDA")
    service.compare("NVDA")

    assert reranker.rerank.call_count == 2


def test_a_passage_belongs_only_to_the_theme_that_ranked_it_highest() -> None:
    service, store, _, _ = make_service()
    shared = hit("shared", Q2)
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2), shared]  # rank 1
    store.hits[(MARGINS, Q2)] = [shared, hit("m1", Q2)]  # rank 0: wins
    tie = hit("tie", Q2)
    store.hits[(DEMAND, Q2)] = [tie]
    store.hits[(GUIDANCE, Q2)].insert(0, tie)  # rank 0 in both: earlier theme

    result = service.compare("NVDA")

    by_key = {t.key: t for t in result.themes}
    assert [p.id for p in by_key["guidance"].current] == [
        "NVDA#FY2027Q2#tie",
        "NVDA#FY2027Q2#g1",
    ]
    assert by_key["demand"].current == []
    assert "NVDA#FY2027Q2#shared" in [p.id for p in by_key["margins"].current]
    ids = [p.id for t in result.themes for p in t.current]
    assert len(ids) == len(set(ids))


def test_rerank_order_decides_within_a_theme_and_limits_apply() -> None:
    reranker = MagicMock()
    # The last candidate is the most relevant.
    reranker.rerank.side_effect = lambda q, docs, n: [
        RerankedItem(i, 0.1 + i / 100) for i in range(len(docs))
    ]
    service, store, _, _ = make_service(reranker=reranker)
    store.hits[(GUIDANCE, Q2)] = [hit(f"g{i}", Q2) for i in range(5)]

    result = service.compare("NVDA")

    assert [p.id for p in result.themes[0].current] == [
        "NVDA#FY2027Q2#g4",
        "NVDA#FY2027Q2#g3",
    ]


def test_focus_comes_first_with_more_passages_and_shapes_the_rerank_query() -> None:
    service, store, reranker, _ = make_service()
    store.hits[("gross margins", Q2)] = [hit(f"f{i}", Q2) for i in range(4)]
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2), hit("g2", Q2)]
    store.hits[("gross margins", Q1)] = [hit("f0", Q1)]

    result = service.compare("NVDA", focus="  gross margins  ")

    assert result.focus == "gross margins"
    assert result.themes[0].key == "focus"
    assert result.themes[0].label == "Focus: gross margins"
    assert len(result.themes[0].current) == 3
    assert len(result.themes[1].current) == 1  # fixed themes keep one
    assert len(result.themes) == len(THEMES) + 1
    assert reranker.rerank.call_count == 2
    assert reranker.rerank.call_args.args[0].endswith("especially gross margins")


def test_rerank_candidates_stay_under_the_100_document_limit() -> None:
    service, store, reranker, _ = make_service()
    for theme in THEMES:
        store.hits[(theme.query, Q2)] = [hit(f"{theme.key}{i}", Q2) for i in range(10)]
    store.hits[("capex", Q2)] = [hit(f"x{i}", Q2) for i in range(10)]

    service.compare("NVDA", focus="capex")

    documents = reranker.rerank.call_args_list[0].args[1]
    assert len(documents) == (len(THEMES) + 1) * CANDIDATES_PER_THEME <= 100


def test_a_quarter_without_candidates_spends_no_rerank_call() -> None:
    service, store, reranker, _ = make_service()
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2)]

    result = service.compare("NVDA")

    assert reranker.rerank.call_count == 1
    assert all(t.prior == [] for t in result.themes)


def test_without_the_reranker_hybrid_order_is_kept() -> None:
    reranker = MagicMock()
    reranker.rerank.side_effect = RerankUnavailableError("quota exhausted")
    service, store, _, _ = make_service(reranker=reranker)
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2, 0.9), hit("g2", Q2, 0.4)]

    result = service.compare("NVDA")

    assert result.status == "ok" and result.reranked is False
    assert [p.id for p in result.themes[0].current] == [
        "NVDA#FY2027Q2#g1",
        "NVDA#FY2027Q2#g2",
    ]


def test_min_score_drops_low_reranked_passages() -> None:
    service, store, _, _ = make_service()
    search = service._search
    store.hits[(GUIDANCE, Q2)] = [hit("g1", Q2), hit("g2", Q2)]

    by_theme, reranked = search.retrieve_themes(
        "NVDA",
        Q2,
        [("guidance", GUIDANCE)],
        rerank_query="outlook",
        candidates_per_theme=6,
        min_score=0.895,
    )

    assert reranked is True
    assert [r.id for r in by_theme["guidance"]] == ["NVDA#FY2027Q2#g1"]


# --- statuses -------------------------------------------------------------------------


def test_requested_quarter_not_indexed_says_which_are() -> None:
    service, _, reranker, _ = make_service()

    result = service.compare("NVDA", current=(2025, 4))

    assert result.status == "quarter_not_indexed"
    assert result.available_quarters == NVDA_QUARTERS
    assert "FY2025Q4 is not indexed for NVDA" in result.message
    reranker.rerank.assert_not_called()


def test_only_one_quarter_indexed() -> None:
    service, _, reranker, _ = make_service(quarters=["FY2027Q2"])

    result = service.compare("NVDA")

    assert result.status == "not_enough_quarters"
    assert "no earlier call to compare" in result.message
    reranker.rerank.assert_not_called()


def test_a_ticker_that_is_not_indexed_starts_on_demand_indexing() -> None:
    service, _, reranker, repo = make_service()

    result = service.compare("AMD")

    assert result.status == "indexing"
    assert repo.tickers["AMD"].status == "indexing"  # the existing claim flow
    reranker.rerank.assert_not_called()
