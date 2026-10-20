"""On-demand refreshes of shared market datasets (no cron).

A dataset (the US symbol list, the earnings calendar) is refreshed when a
request finds it older than its max age. The refresh runs in the background
while the request is served from what's stored, and a lease row in
``market_refresh_state`` lets only one run at a time, across processes. A
row-based lease is used rather than an advisory lock because the pooled
(PgBouncer) connection can't hold a session lock.

A failed attempt keeps the old data and backs off for ``retry_after``; a
lease older than ``stale_after`` belonged to a refresh that died and may be
re-claimed.
"""

import logging
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import psycopg
from psycopg import Connection
from psycopg_pool import ConnectionPool

from app.config import get_settings
from app.services.rag.repository import utcnow

from .repository import shared_pool

logger = logging.getLogger(__name__)

US_SYMBOLS = "us_symbols"
EARNINGS_CALENDAR = "earnings_calendar"


@dataclass(frozen=True)
class RefreshState:
    """A ``market_refresh_state`` row (timestamps naive UTC)."""

    dataset: str
    refreshed_at: datetime | None
    attempted_at: datetime | None
    refreshing_since: datetime | None
    row_count: int
    covered_from: date | None
    covered_to: date | None
    last_error: str | None


@dataclass(frozen=True)
class RefreshPolicy:
    max_age: timedelta
    retry_after: timedelta
    stale_after: timedelta


def is_refreshing(
    state: RefreshState | None, now: datetime, policy: RefreshPolicy
) -> bool:
    """Whether a live refresh holds the lease."""
    since = state.refreshing_since if state else None
    return since is not None and since > now - policy.stale_after


def is_due(state: RefreshState | None, now: datetime, policy: RefreshPolicy) -> bool:
    """Whether the dataset should be refreshed now."""
    if state is None:
        return True
    if is_refreshing(state, now, policy):
        return False
    if state.refreshed_at is not None and state.refreshed_at > now - policy.max_age:
        return False
    failed_last = state.attempted_at is not None and (
        state.refreshed_at is None or state.attempted_at > state.refreshed_at
    )
    return not (failed_last and state.attempted_at > now - policy.retry_after)


_STATE_COLUMNS = """
    dataset, refreshed_at, attempted_at, refreshing_since, row_count,
    covered_from, covered_to, last_error
"""


class RefreshStateRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def get(self, dataset: str) -> RefreshState | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                f"SELECT {_STATE_COLUMNS} FROM market_refresh_state WHERE dataset = %s",
                (dataset,),
            ).fetchone()
        return RefreshState(**row) if row else None

    def claim(
        self, dataset: str, policy: RefreshPolicy, *, now: datetime | None = None
    ) -> str | None:
        """Take the lease if a refresh is due; its id, else None."""
        now = now or utcnow()
        with self._pool.connection() as conn, conn.transaction():
            conn.execute(
                """
                INSERT INTO market_refresh_state (dataset) VALUES (%s)
                ON CONFLICT (dataset) DO NOTHING
                """,
                (dataset,),
            )
            row = conn.execute(
                f"""
                SELECT {_STATE_COLUMNS} FROM market_refresh_state
                WHERE dataset = %s FOR UPDATE
                """,
                (dataset,),
            ).fetchone()
            if not is_due(RefreshState(**row), now, policy):
                return None
            refresh_id = str(uuid.uuid4())
            conn.execute(
                """
                UPDATE market_refresh_state
                SET refreshing_since = %s, refresh_id = %s, attempted_at = %s
                WHERE dataset = %s
                """,
                (now, refresh_id, now, dataset),
            )
            return refresh_id

    def fail(self, dataset: str, refresh_id: str, error: str) -> None:
        """Release the lease after a failed attempt, keeping the old data."""
        with self._pool.connection() as conn:
            conn.execute(
                """
                UPDATE market_refresh_state
                SET refreshing_since = NULL, refresh_id = NULL, last_error = %s
                WHERE dataset = %s AND refresh_id = %s
                """,
                (error[:500], dataset, refresh_id),
            )


def hold_lease(conn: Connection, dataset: str, refresh_id: str) -> bool:
    """Lock the state row if ``refresh_id`` still holds the lease.

    Call inside the transaction that writes the data, so a refresh whose lease
    was re-claimed (it ran past the stale window) writes nothing.
    """
    row = conn.execute(
        """
        SELECT 1 FROM market_refresh_state
        WHERE dataset = %s AND refresh_id = %s FOR UPDATE
        """,
        (dataset, refresh_id),
    ).fetchone()
    return row is not None


def mark_refreshed(
    conn: Connection,
    dataset: str,
    *,
    row_count: int,
    now: datetime,
    covered_from: date | None = None,
    covered_to: date | None = None,
) -> None:
    """Record a successful refresh and release the lease (same transaction)."""
    conn.execute(
        """
        UPDATE market_refresh_state
        SET refreshed_at = %s, refreshing_since = NULL, refresh_id = NULL,
            row_count = %s, covered_from = %s, covered_to = %s, last_error = NULL
        WHERE dataset = %s
        """,
        (now, row_count, covered_from, covered_to, dataset),
    )


class BackgroundRefresher:
    """Runs refresh jobs off the request thread, one at a time per dataset.

    The in-process guard only saves threads (every keystroke of a search may
    ask); the database lease is what keeps refreshes single across processes.
    """

    def __init__(self, max_workers: int = 2) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers, thread_name_prefix="market-refresh"
        )
        self._running: set[str] = set()
        self._lock = threading.Lock()

    def submit(self, dataset: str, job: Callable[[], object]) -> bool:
        """Start ``job`` unless one for ``dataset`` is already running here."""
        with self._lock:
            if dataset in self._running:
                return False
            self._running.add(dataset)
        try:
            self._executor.submit(self._run, dataset, job)
        except RuntimeError:  # shutting down
            self._done(dataset)
            return False
        return True

    def _run(self, dataset: str, job: Callable[[], object]) -> None:
        try:
            job()
        except Exception:
            logger.exception("%s refresh crashed", dataset)
        finally:
            self._done(dataset)

    def _done(self, dataset: str) -> None:
        with self._lock:
            self._running.discard(dataset)

    def shutdown(self) -> None:
        """Stop taking jobs; a running one is abandoned (its lease goes stale)."""
        self._executor.shutdown(wait=False, cancel_futures=True)


class FreshnessCheck:
    """Starts a background refresh of one dataset when it's due.

    The stored state is read at most once per ``check_every``, so a request
    that asks on every call (search as you type) adds no query per call.
    """

    def __init__(
        self,
        dataset: str,
        *,
        states: Callable[[], RefreshStateRepository | None],
        refresher: BackgroundRefresher,
        policy: RefreshPolicy,
        clock: Callable[[], datetime] = utcnow,
        check_every: timedelta = timedelta(seconds=60),
    ) -> None:
        self._dataset = dataset
        self._states = states
        self._refresher = refresher
        self._policy = policy
        self._clock = clock
        self._check_every = check_every
        self._next_check: datetime | None = None
        self._lock = threading.Lock()

    def ensure_fresh(self, job: Callable[[], object]) -> None:
        """Submit ``job`` if the dataset is due; never waits for it."""
        now = self._clock()
        with self._lock:
            if self._next_check is not None and now < self._next_check:
                return
            self._next_check = now + self._check_every
        states = self._states()
        if states is None:
            return
        try:
            state = states.get(self._dataset)
        except psycopg.Error as exc:
            logger.warning("%s state read failed: %s", self._dataset, exc)
            return
        if is_due(state, now, self._policy):
            self._refresher.submit(self._dataset, job)


def refresh_policy(max_age: timedelta) -> RefreshPolicy:
    settings = get_settings()
    return RefreshPolicy(
        max_age=max_age,
        retry_after=timedelta(minutes=settings.market_refresh_retry_minutes),
        stale_after=timedelta(minutes=settings.market_refresh_stale_minutes),
    )


def shared_state_repository() -> RefreshStateRepository | None:
    pool = shared_pool()
    return RefreshStateRepository(pool) if pool is not None else None


_refresher: BackgroundRefresher | None = None
_refresher_lock = threading.Lock()


def get_background_refresher() -> BackgroundRefresher:
    global _refresher
    with _refresher_lock:
        if _refresher is None:
            _refresher = BackgroundRefresher()
        return _refresher


def shutdown_background_refresher() -> None:
    with _refresher_lock:
        if _refresher is not None:
            _refresher.shutdown()
