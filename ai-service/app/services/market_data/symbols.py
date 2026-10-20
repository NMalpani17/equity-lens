"""The US symbol list behind company search (``market_symbols``).

Finnhub's full US list (one API call, ~31k rows) is filtered to common stocks,
ETFs and ADRs, given readable names ("MICROSOFT CORP" -> "Microsoft Corp"),
and stored whole. A search that finds the list older than a day refreshes it
in the background (see :mod:`.refresh`); searches always read Postgres, so
they cost no Finnhub calls. If Finnhub is down the stored list keeps serving.
"""

import logging
import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from app.config import get_settings
from app.services.rag.repository import utcnow

from .base import ProviderUnavailableError
from .refresh import (
    US_SYMBOLS,
    BackgroundRefresher,
    RefreshPolicy,
    RefreshStateRepository,
    get_background_refresher,
    hold_lease,
    is_due,
    mark_refreshed,
)
from .repository import shared_pool
from .service import get_finnhub_provider

logger = logging.getLogger(__name__)

# Finnhub's type -> ours. Everything else (REITs, funds, warrants...) is left out.
SYMBOL_TYPES = {"Common Stock": "stock", "ETP": "etf", "ADR": "adr"}
OTC_EXCHANGE = "OOTC"
# What the api accepts as a ticker (api/src/schemas/holding.schema.ts).
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
# A list this short (or under half the stored one) is a bad response, not a
# market change, so it never replaces the stored list.
MIN_SYMBOLS = 1000

# Kept upper-case in display names.
_ACRONYMS = frozenset(
    {
        "ADR", "ADS", "AG", "AI", "ASA", "BDC", "CRSP", "ESG", "ETF", "ETN",
        "ETP", "FTSE", "II", "III", "IV", "LLC", "LP", "MSCI", "NA", "NV",
        "PLC", "REIT", "SA", "SE", "SPDR", "SS", "TIPS", "UK", "US", "USA", "VI",
    }
)  # fmt: skip
_SMALL_WORDS = frozenset({"and", "for", "in", "of", "on", "the"})
_SPECIAL = {
    "BLACKROCK": "BlackRock",
    "ISHARES": "iShares",
    "JPMORGAN": "JPMorgan",
    "PAYPAL": "PayPal",
    "PROSHARES": "ProShares",
    "VANECK": "VanEck",
    "WISDOMTREE": "WisdomTree",
}
_NON_SEARCH_CHARS = re.compile(r"[^a-z0-9&]+")


@dataclass(frozen=True)
class SymbolRow:
    ticker: str
    name: str
    name_raw: str
    search_name: str
    type: str
    exchange: str | None


def normalize_search(text: str) -> str:
    """Lowercase, with punctuation as single spaces ("Amazon.com" -> "amazon com")."""
    return _NON_SEARCH_CHARS.sub(" ", text.lower()).strip()


def _word(token: str, first: bool) -> str:
    if token in _SPECIAL:
        return _SPECIAL[token]
    if token in _ACRONYMS or "&" in token or any(c.isdigit() for c in token):
        return token
    if len(token) == 1:
        return token
    lower = token.lower()
    if not first and lower in _SMALL_WORDS:
        return lower
    return token[0] + token[1:].lower()


def display_name(raw: str, ticker: str) -> str:
    """A readable name from Finnhub's upper-case description, else the ticker."""
    words = raw.split()
    if not words:
        return ticker
    out = []
    for index, word in enumerate(words):
        parts = word.split("-")
        out.append(
            "-".join(_word(p, index == 0 and i == 0) for i, p in enumerate(parts))
        )
    return " ".join(out)


def parse_symbol_list(payload: Iterable[Any]) -> list[SymbolRow]:
    """The rows we keep: known types and valid tickers, first row per ticker."""
    rows: dict[str, SymbolRow] = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        kind = SYMBOL_TYPES.get(item.get("type") or "")
        ticker = str(item.get("symbol") or "").strip().upper()
        if kind is None or not TICKER_RE.match(ticker) or ticker in rows:
            continue
        raw = " ".join(str(item.get("description") or "").split())
        name = display_name(raw, ticker)
        rows[ticker] = SymbolRow(
            ticker=ticker,
            name=name,
            name_raw=raw,
            search_name=normalize_search(raw) or ticker.lower(),
            type=kind,
            exchange=str(item.get("mic") or "") or None,
        )
    return list(rows.values())


class SymbolRepository:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def count(self) -> int:
        with self._pool.connection() as conn:
            row = conn.execute("SELECT count(*) AS n FROM market_symbols").fetchone()
        return int(row["n"]) if row else 0

    def replace_all(
        self, rows: Sequence[SymbolRow], *, refresh_id: str, now: datetime
    ) -> bool:
        """Swap in the new list and finish the refresh, in one transaction.

        False (nothing written) if the lease was lost to another refresh.
        """
        with self._pool.connection() as conn, conn.transaction():
            if not hold_lease(conn, US_SYMBOLS, refresh_id):
                return False
            conn.execute(
                """
                CREATE TEMP TABLE incoming_symbols (LIKE market_symbols)
                ON COMMIT DROP
                """
            )
            with conn.cursor().copy(
                """
                COPY incoming_symbols
                    (ticker, name, name_raw, search_name, type, exchange, updated_at)
                FROM STDIN
                """
            ) as copy:
                for r in rows:
                    copy.write_row(
                        (
                            r.ticker,
                            r.name,
                            r.name_raw,
                            r.search_name,
                            r.type,
                            r.exchange,
                            now,
                        )
                    )
            conn.execute(
                """
                INSERT INTO market_symbols
                    (ticker, name, name_raw, search_name, type, exchange, updated_at)
                SELECT ticker, name, name_raw, search_name, type, exchange, updated_at
                FROM incoming_symbols
                ON CONFLICT (ticker) DO UPDATE SET
                    name = EXCLUDED.name,
                    name_raw = EXCLUDED.name_raw,
                    search_name = EXCLUDED.search_name,
                    type = EXCLUDED.type,
                    exchange = EXCLUDED.exchange,
                    updated_at = EXCLUDED.updated_at
                """
            )
            conn.execute(
                """
                DELETE FROM market_symbols m
                WHERE NOT EXISTS (
                    SELECT 1 FROM incoming_symbols i WHERE i.ticker = m.ticker
                )
                """
            )
            mark_refreshed(conn, US_SYMBOLS, row_count=len(rows), now=now)
        return True


class SymbolListService:
    """Keeps ``market_symbols`` fresh (searching lives in a later layer)."""

    def __init__(
        self,
        *,
        fetch_list: Callable[[], list[dict]],
        states: Callable[[], RefreshStateRepository | None],
        symbols: Callable[[], SymbolRepository | None],
        refresher: BackgroundRefresher,
        policy: RefreshPolicy,
        clock: Callable[[], datetime] = utcnow,
        check_every: timedelta = timedelta(seconds=60),
    ) -> None:
        self._fetch_list = fetch_list
        self._states = states
        self._symbols = symbols
        self._refresher = refresher
        self._policy = policy
        self._clock = clock
        self._check_every = check_every
        self._next_check: datetime | None = None

    def ensure_fresh(self) -> None:
        """Start a background refresh if the list is due; never blocks on it.

        The stored state is read at most once a minute, so searching as you
        type doesn't add a query per keystroke.
        """
        now = self._clock()
        if self._next_check is not None and now < self._next_check:
            return
        self._next_check = now + self._check_every
        states = self._states()
        if states is None:
            return
        try:
            state = states.get(US_SYMBOLS)
        except psycopg.Error as exc:
            logger.warning("symbol list state read failed: %s", exc)
            return
        if is_due(state, now, self._policy):
            self._refresher.submit(US_SYMBOLS, self.refresh)

    def refresh(self) -> bool:
        """Reload the list if due and the lease is ours; True when replaced."""
        states, symbols = self._states(), self._symbols()
        if states is None or symbols is None:
            return False
        refresh_id = states.claim(US_SYMBOLS, self._policy, now=self._clock())
        if refresh_id is None:
            return False
        try:
            rows = parse_symbol_list(self._fetch_list())
            floor = max(MIN_SYMBOLS, symbols.count() // 2)
            if len(rows) < floor:
                raise ProviderUnavailableError(
                    f"symbol list had {len(rows)} rows, expected at least {floor}"
                )
            replaced = symbols.replace_all(
                rows, refresh_id=refresh_id, now=self._clock()
            )
        except Exception as exc:  # any failure must release the lease
            logger.warning("symbol list refresh failed, keeping the old list: %s", exc)
            states.fail(US_SYMBOLS, refresh_id, str(exc))
            return False
        if replaced:
            logger.info("symbol list refreshed: %d symbols", len(rows))
        else:
            logger.warning("symbol list refresh lost its lease; nothing written")
        return replaced


def shared_state_repository() -> RefreshStateRepository | None:
    pool = shared_pool()
    return RefreshStateRepository(pool) if pool is not None else None


def shared_symbol_repository() -> SymbolRepository | None:
    pool = shared_pool()
    return SymbolRepository(pool) if pool is not None else None


def refresh_policy(max_age: timedelta) -> RefreshPolicy:
    settings = get_settings()
    return RefreshPolicy(
        max_age=max_age,
        retry_after=timedelta(minutes=settings.market_refresh_retry_minutes),
        stale_after=timedelta(minutes=settings.market_refresh_stale_minutes),
    )


@lru_cache
def get_symbol_list_service() -> SymbolListService:
    settings = get_settings()
    return SymbolListService(
        fetch_list=get_finnhub_provider().get_symbol_list,
        states=shared_state_repository,
        symbols=shared_symbol_repository,
        refresher=get_background_refresher(),
        policy=refresh_policy(timedelta(hours=settings.symbols_refresh_hours)),
    )
