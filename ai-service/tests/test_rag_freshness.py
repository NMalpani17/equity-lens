"""Freshness refresh: stale checks, once-per-day, refresh jobs and the cap.

Also covers the rule that a ticker being refreshed (``indexing`` but indexed
before) is searched immediately from its existing vectors, on both the
/rag/search route and the chat tool.
"""

import logging
from collections.abc import Iterator, Sequence
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.chat.transcripts import SearchDeps, search_transcripts
from app.services.rag.cache import TTLCache
from app.services.rag.container import get_rag_components
from app.services.rag.freshness import (
    FreshnessOutcome,
    FreshnessRefresher,
    needs_check,
)
from app.services.rag.ingestion import IngestionPipeline, TranscriptSource
from app.services.rag.jobs import IngestionCoordinator
from app.services.rag.repository import TickerRecord
from app.services.rag.reranker import RerankedItem
from app.services.rag.search import RagSearchService
from app.services.rag.vector_store import SearchHit
from tests.chat_fakes import turn
from tests.conftest import INTERNAL_HEADERS
from tests.rag_fakes import (
    FakeEmbedder,
    FakeEquibles,
    FakeRepo,
    FakeSparse,
    InlineExecutor,
)

INDEXED = [(2025, 4), (2025, 3), (2025, 2), (2025, 1)]
NOW = datetime(2026, 3, 1, 12, 0)  # the newest indexed call (2025-04-15) is stale
STALE_JOB = timedelta(minutes=30)


class FakeStore:
    """Vector IDs per namespace, with Pinecone-like prefix deletes."""

    def __init__(self, hits: Sequence[SearchHit] = ()) -> None:
        self.ids: dict[str, set[str]] = {}
        self.hits = list(hits)
        self.queries = 0

    def ensure_index(self) -> None:
        pass

    def upsert_chunks(self, chunks, dense, sparse, *, namespace: str) -> int:
        self.ids.setdefault(namespace, set()).update(c.id for c in chunks)
        return len(chunks)

    def delete_stale(self, prefix: str, keep_ids: set[str], *, namespace: str) -> int:
        ids = self.ids.setdefault(namespace, set())
        stale = {i for i in ids if i.startswith(prefix) and i not in keep_ids}
        ids -= stale
        return len(stale)

    def delete_prefix(self, prefix: str, *, namespace: str) -> int:
        return self.delete_stale(prefix, set(), namespace=namespace)

    def query(self, **_: object) -> list[SearchHit]:
        self.queries += 1
        return self.hits

    def quarters(self, ticker: str = "AAPL") -> set[str]:
        return {
            i.split("#")[1] for i in self.ids.get("ctx", set()) if i.startswith(ticker)
        }


class Env(SimpleNamespace):
    repo: FakeRepo
    equibles: FakeEquibles
    store: FakeStore
    embedder: FakeEmbedder
    executor: InlineExecutor
    coordinator: IngestionCoordinator
    refresher: FreshnessRefresher
    clock: list[datetime]


def make_env(*, cap: int = 3, run_tasks: bool = True) -> Env:
    repo = FakeRepo()
    equibles = FakeEquibles({"AAPL": list(INDEXED)})
    store = FakeStore()
    embedder = FakeEmbedder()
    pipeline = IngestionPipeline(
        TranscriptSource(equibles, repo, quarters=4),
        embedder,
        FakeSparse(),
        store,
        namespace="ctx",
        plain_namespace="plain",
        chunk_tokens=400,
        overlap_tokens=60,
    )
    executor = InlineExecutor(run=True)
    coordinator = IngestionCoordinator(
        repo, pipeline, executor, daily_cap=8, stale_after=STALE_JOB
    )
    coordinator.request_on_demand("AAPL")  # index FY2025 Q1-Q4
    executor.run = run_tasks
    executor.submitted.clear()
    equibles.calls.clear()
    clock = [NOW]
    refresher = FreshnessRefresher(
        repo,
        equibles,
        coordinator,
        stale_after_days=90,
        daily_cap=cap,
        stale_job_after=STALE_JOB,
        clock=lambda: clock[0],
    )
    return Env(
        repo=repo,
        equibles=equibles,
        store=store,
        embedder=embedder,
        executor=executor,
        coordinator=coordinator,
        refresher=refresher,
        clock=clock,
    )


def publish_newer_call(env: Env) -> None:
    env.equibles.periods["AAPL"] = [(2026, 1), *INDEXED]


# --- stale vs fresh -----------------------------------------------------------


def record(**overrides) -> TickerRecord:
    base = TickerRecord(
        "AAPL",
        "indexed",
        "AAPL Holdings Inc",
        12,
        ["FY2025Q4"],
        indexed_at=datetime(2025, 5, 1),
        latest_call_date=date(2025, 4, 15),
    )
    return TickerRecord(**{**base.__dict__, **overrides})


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, True),  # newest call is 320 days old
        ({"latest_call_date": date(2026, 1, 15)}, False),  # 45 days: fresh
        ({"latest_call_date": None}, True),  # unknown date: check
        ({"freshness_checked_at": datetime(2026, 3, 1, 8)}, False),  # today
        ({"freshness_checked_at": datetime(2026, 2, 28, 23)}, True),  # yesterday
        ({"indexed_at": None, "status": "indexing"}, False),  # never indexed
        ({"status": "failed"}, False),
        ({"status": "indexing"}, True),  # a stuck refresh gets re-checked
    ],
)
def test_needs_check(overrides: dict, expected: bool) -> None:
    assert (
        needs_check(record(**overrides), now=NOW, stale_after=timedelta(days=90))
        is expected
    )


def test_stale_ticker_queues_one_background_check_without_calling_equibles() -> None:
    env = make_env(run_tasks=False)

    queued = env.refresher.maybe_check(env.repo.get_ticker("AAPL"))
    again = env.refresher.maybe_check(env.repo.get_ticker("AAPL"))

    assert queued is True
    assert again is False  # already in flight in this process
    assert len(env.executor.submitted) == 1
    assert env.equibles.calls == []  # nothing ran on the caller's thread


def test_fresh_ticker_queues_nothing() -> None:
    env = make_env(run_tasks=False)
    env.clock[0] = datetime(2025, 6, 1)  # newest call (2025-04-15) is 47 days old

    assert env.refresher.maybe_check(env.repo.get_ticker("AAPL")) is False
    assert env.executor.submitted == []


def test_cap_zero_turns_refresh_off() -> None:
    env = make_env(cap=0, run_tasks=False)

    assert env.refresher.maybe_check(env.repo.get_ticker("AAPL")) is False
    assert env.executor.submitted == []


# --- once per day -------------------------------------------------------------


def test_checks_a_ticker_at_most_once_per_utc_day() -> None:
    env = make_env()

    first = env.refresher.check("AAPL")
    second = env.refresher.check("AAPL")
    env.clock[0] = NOW + timedelta(days=1)
    next_day = env.refresher.check("AAPL")

    assert first is FreshnessOutcome.UP_TO_DATE
    assert second is FreshnessOutcome.ALREADY_CHECKED
    assert next_day is FreshnessOutcome.UP_TO_DATE
    assert env.equibles.calls == ["list:AAPL", "list:AAPL"]
    assert env.repo.get_ticker("AAPL").freshness_checked_at == NOW + timedelta(days=1)


def test_checked_today_is_recorded_so_searches_skip_it() -> None:
    env = make_env(run_tasks=False)
    env.refresher.check("AAPL")

    assert env.refresher.maybe_check(env.repo.get_ticker("AAPL")) is False


# --- newer call found vs not ----------------------------------------------------


def test_no_newer_call_starts_no_job(caplog: pytest.LogCaptureFixture) -> None:
    env = make_env()
    jobs_before = set(env.repo.jobs)

    with caplog.at_level(logging.INFO, logger="app.services.rag.freshness"):
        outcome = env.refresher.check("AAPL")

    assert outcome is FreshnessOutcome.UP_TO_DATE
    assert set(env.repo.jobs) == jobs_before
    assert env.repo.refreshes_used == 0
    fields = caplog.records[-1].fields
    assert fields == {
        "event": "rag_freshness_check",
        "ticker": "AAPL",
        "outcome": "up_to_date",
        "newest_indexed": "FY2025Q4",
        "newest_available": "FY2025Q4",
    }


def test_newer_call_is_indexed_and_the_oldest_quarter_removed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    env = make_env()
    publish_newer_call(env)
    before = env.repo.get_ticker("AAPL")

    with caplog.at_level(logging.INFO, logger="app.services.rag.freshness"):
        outcome = env.refresher.check("AAPL")

    assert outcome is FreshnessOutcome.REFRESH_STARTED
    # One list call plus only the new transcript: nothing re-fetched.
    assert env.equibles.calls == ["list:AAPL", "get:AAPL:2026Q1"]
    # Only the new quarter was embedded.
    assert len(env.embedder.last_texts) == 3
    assert env.store.quarters() == {"FY2026Q1", "FY2025Q4", "FY2025Q3", "FY2025Q2"}
    after = env.repo.get_ticker("AAPL")
    assert after.status == "indexed"
    assert after.quarters == ["FY2026Q1", "FY2025Q4", "FY2025Q3", "FY2025Q2"]
    assert after.chunk_count == before.chunk_count  # +3 new, -3 removed
    assert after.latest_call_date == date(2026, 1, 15)
    assert after.company_name == "AAPL Holdings Inc"
    job = env.repo.jobs[after.last_job_id]
    assert (job.trigger, job.status) == ("refresh", "succeeded")
    # The refresh used its own counter, not the new-ticker one.
    assert env.repo.refreshes_used == 1
    assert env.repo.daily_used == 1  # only the initial on-demand ingestion
    events = [r.fields for r in caplog.records if hasattr(r, "fields")]
    assert [(e["event"], e.get("outcome")) for e in events] == [
        ("rag_freshness_check", "refresh_started"),
        ("rag_freshness_refresh", None),
    ]
    assert events[0]["newest_available"] == "FY2026Q1"
    assert events[1]["succeeded"] is True
    assert events[1]["quarters"] == after.quarters


def test_window_not_full_removes_nothing() -> None:
    env = make_env()
    env.repo.tickers["AAPL"] = TickerRecord(
        **{
            **env.repo.tickers["AAPL"].__dict__,
            "quarters": ["FY2025Q4", "FY2025Q3"],
            "chunk_count": 6,
        }
    )
    env.store.ids["ctx"] = {
        i for i in env.store.ids["ctx"] if "FY2025Q4" in i or "FY2025Q3" in i
    }
    env.equibles.periods["AAPL"] = [(2026, 1), (2025, 4), (2025, 3)]

    assert env.refresher.check("AAPL") is FreshnessOutcome.REFRESH_STARTED

    assert env.store.quarters() == {"FY2026Q1", "FY2025Q4", "FY2025Q3"}
    assert env.repo.get_ticker("AAPL").chunk_count == 9


# --- refresh cap ----------------------------------------------------------------


def test_refresh_cap_reached_starts_no_job_and_spares_the_new_ticker_cap() -> None:
    env = make_env(cap=1)
    env.repo.refreshes_used = 1
    publish_newer_call(env)
    jobs_before = set(env.repo.jobs)

    outcome = env.refresher.check("AAPL")

    assert outcome is FreshnessOutcome.REFRESH_CAP_REACHED
    assert set(env.repo.jobs) == jobs_before
    assert env.repo.daily_used == 1
    assert env.repo.get_ticker("AAPL").status == "indexed"
    assert env.equibles.calls == ["list:AAPL"]
    # Recorded as checked: tomorrow's check (and cap) gets the next try.
    assert env.refresher.check("AAPL") is FreshnessOutcome.ALREADY_CHECKED


# --- failures ---------------------------------------------------------------------


def test_failed_refresh_keeps_the_ticker_indexed_and_searchable() -> None:
    env = make_env()
    publish_newer_call(env)
    env.equibles.missing.add(("AAPL", 2026, 1))

    env.refresher.check("AAPL")

    after = env.repo.get_ticker("AAPL")
    assert after.status == "indexed"
    assert after.last_error
    assert after.quarters == ["FY2025Q4", "FY2025Q3", "FY2025Q2", "FY2025Q1"]
    assert env.store.quarters() == {"FY2025Q4", "FY2025Q3", "FY2025Q2", "FY2025Q1"}
    assert env.repo.jobs[after.last_job_id].status == "failed"


def test_equibles_error_is_logged_and_waits_for_tomorrow(
    caplog: pytest.LogCaptureFixture,
) -> None:
    env = make_env()
    env.equibles.list_earnings_calls = MagicMock(side_effect=RuntimeError("down"))

    with caplog.at_level(logging.INFO, logger="app.services.rag.freshness"):
        outcome = env.refresher.check("AAPL")

    assert outcome is FreshnessOutcome.ERROR
    assert caplog.records[-1].levelno == logging.WARNING
    assert caplog.records[-1].fields["error"] == "down"
    assert env.refresher.check("AAPL") is FreshnessOutcome.ALREADY_CHECKED


# --- a refresh in progress never delays a search -----------------------------------

HIT = SearchHit(
    id="AAPL#FY2025Q4#0001",
    score=0.8,
    metadata={
        "ticker": "AAPL",
        "company_name": "AAPL Holdings Inc",
        "fiscal_year": 2025.0,
        "fiscal_quarter": 4.0,
        "call_date": "2025-04-15",
        "speaker": "CEO",
        "section": "prepared_remarks",
        "chunk_index": 1.0,
        "context_header": "AAPL · Q4 FY2025 earnings call",
        "text": "Services revenue reached a record.",
    },
)


@pytest.fixture
def refreshing() -> SimpleNamespace:
    """A search service whose AAPL refresh job is running right now."""
    env = make_env(run_tasks=False)
    publish_newer_call(env)
    claim = env.repo.claim_ingestion(
        "AAPL", trigger="refresh", daily_cap=3, stale_after=STALE_JOB, refresh=True
    )
    assert env.repo.get_ticker("AAPL").status == "indexing"
    env.store.hits = [HIT]
    reranker = MagicMock()
    reranker.rerank.return_value = [RerankedItem(0, 0.9)]
    service = RagSearchService(
        env.repo,
        env.coordinator,
        FakeEmbedder(),
        FakeSparse(),
        env.store,
        reranker,
        rerank_cache=TTLCache(10, 60),
        namespace="ctx",
        candidate_k=25,
        alpha=0.75,
        freshness=env.refresher,
    )
    return SimpleNamespace(env=env, service=service, job_id=claim.job_id)


def assert_no_new_ingestion(refreshing: SimpleNamespace) -> None:
    """Only the initial ingestion and the running refresh job exist."""
    env = refreshing.env
    assert len(env.repo.jobs) == 2
    assert env.repo.get_ticker("AAPL").last_job_id == refreshing.job_id
    assert env.repo.daily_used == 1


@pytest.fixture
def client(refreshing: SimpleNamespace) -> Iterator[TestClient]:
    app.dependency_overrides[get_rag_components] = lambda: SimpleNamespace(
        search=refreshing.service, repo=refreshing.env.repo
    )
    yield TestClient(app, headers=INTERNAL_HEADERS)
    app.dependency_overrides.clear()


def test_rag_search_answers_from_existing_vectors_during_a_refresh(
    client: TestClient, refreshing: SimpleNamespace
) -> None:
    res = client.post("/rag/search", json={"query": "services", "ticker": "AAPL"})

    assert res.status_code == 200  # never 202 while refreshing
    assert [r["id"] for r in res.json()["results"]] == ["AAPL#FY2025Q4#0001"]
    assert_no_new_ingestion(refreshing)


def chat_deps(refreshing: SimpleNamespace) -> tuple[SearchDeps, list[float]]:
    clock = [0.0]

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    deps = SearchDeps(
        search=lambda: refreshing.service,
        resolver=MagicMock,
        ticker_record=refreshing.env.repo.get_ticker,
        sleep=sleep,
        clock=lambda: clock[0],
    )
    return deps, clock


@pytest.mark.parametrize("quarters", [None, 2])
def test_chat_tool_answers_from_existing_vectors_during_a_refresh(
    refreshing: SimpleNamespace, quarters: int | None
) -> None:
    deps, clock = chat_deps(refreshing)
    progress: list[str] = []
    ctx = turn()
    ctx.progress = progress.append

    out = search_transcripts(
        deps, ctx, query="services revenue", ticker="AAPL", quarters=quarters
    )

    assert out.data["status"] == "ok"
    passages = [(p["fiscal_year"], p["fiscal_quarter"]) for p in out.data["passages"]]
    assert passages == [(2025, 4)]  # the existing FY2025Q4 vectors
    assert clock[0] == 0.0  # never slept waiting for indexing
    assert not any(label.startswith("Indexing") for label in progress)
    assert_no_new_ingestion(refreshing)
