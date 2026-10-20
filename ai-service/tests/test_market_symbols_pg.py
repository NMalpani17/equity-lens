"""Symbol list and refresh lease SQL against a real Postgres (skipped without one).

Set AI_SERVICE_TEST_DATABASE_URL to a throwaway database (never production):
the tests apply the market tracking migration into a fresh schema and drop it
afterwards. pg_trgm is installed once per database, in "extensions".
"""

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pytest

TEST_DB_URL = os.environ.get("AI_SERVICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="AI_SERVICE_TEST_DATABASE_URL not set"
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "api/prisma/migrations"
MIGRATION = (
    MIGRATIONS_DIR / "20261019000000_add_market_symbols_and_earnings/migration.sql"
)
T0 = datetime(2026, 10, 19, 15, 0)


@dataclass
class Db:
    pool: object
    states: object
    symbols: object


@pytest.fixture
def db() -> Iterator[Db]:
    import psycopg
    from psycopg.conninfo import make_conninfo

    from app.services.market_data.refresh import RefreshStateRepository
    from app.services.market_data.symbols import SymbolRepository
    from app.services.rag.repository import create_pool

    schema = f"symbols_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'SET search_path TO "{schema}"')
        conn.execute(MIGRATION.read_text())
    pool = create_pool(
        make_conninfo(TEST_DB_URL, options=f"-c search_path={schema}"), max_size=6
    )
    try:
        yield Db(pool, RefreshStateRepository(pool), SymbolRepository(pool))
    finally:
        pool.close()
        with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')


def policy():
    from app.services.market_data.refresh import RefreshPolicy

    return RefreshPolicy(
        max_age=timedelta(hours=24),
        retry_after=timedelta(minutes=30),
        stale_after=timedelta(minutes=10),
    )


def rows(*tickers: str):
    from app.services.market_data.symbols import parse_symbol_list

    return parse_symbol_list(
        [
            {"symbol": t, "description": f"{t} CORP", "type": "Common Stock"}
            for t in tickers
        ]
    ).rows


def stored(db: Db) -> list[str]:
    with db.pool.connection() as conn:
        return [
            r["ticker"]
            for r in conn.execute("SELECT ticker FROM market_symbols ORDER BY ticker")
        ]


def test_only_one_concurrent_claim_wins(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    with ThreadPoolExecutor(6) as pool:
        claims = list(
            pool.map(lambda _: db.states.claim(US_SYMBOLS, policy(), now=T0), range(6))
        )

    assert sum(c is not None for c in claims) == 1


def test_a_fresh_list_is_not_claimed_and_a_stale_lease_is(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    assert first is not None
    # Still running (inside the stale window): nobody else may start.
    assert db.states.claim(US_SYMBOLS, policy(), now=T0 + timedelta(minutes=5)) is None
    # The holder died; after the stale window and the failure backoff it's free.
    later = T0 + timedelta(minutes=31)
    second = db.states.claim(US_SYMBOLS, policy(), now=later)
    assert second not in (None, first)

    assert db.symbols.replace_all(rows("MSFT"), refresh_id=second, now=later)
    state = db.states.get(US_SYMBOLS)
    assert state.refreshed_at == later and state.refreshing_since is None
    assert state.row_count == 1
    # Fresh for a day.
    assert (
        db.states.claim(US_SYMBOLS, policy(), now=later + timedelta(hours=23)) is None
    )
    assert db.states.claim(US_SYMBOLS, policy(), now=later + timedelta(hours=25))


def test_a_failed_attempt_backs_off_and_keeps_the_list(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    db.symbols.replace_all(rows("AAPL", "MSFT"), refresh_id=first, now=T0)

    day_later = T0 + timedelta(hours=25)
    failing = db.states.claim(US_SYMBOLS, policy(), now=day_later)
    db.states.fail(US_SYMBOLS, failing, "finnhub server error: 503")

    state = db.states.get(US_SYMBOLS)
    assert state.last_error == "finnhub server error: 503"
    assert state.refreshing_since is None
    assert stored(db) == ["AAPL", "MSFT"]
    assert (
        db.states.claim(US_SYMBOLS, policy(), now=day_later + timedelta(minutes=10))
        is None
    )
    assert db.states.claim(US_SYMBOLS, policy(), now=day_later + timedelta(minutes=31))


def test_replace_swaps_the_whole_list(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    db.symbols.replace_all(rows("AAPL", "GONE", "MSFT"), refresh_id=first, now=T0)
    later = T0 + timedelta(days=2)
    second = db.states.claim(US_SYMBOLS, policy(), now=later)

    assert db.symbols.replace_all(
        rows("AAPL", "MSFT", "NEW"), refresh_id=second, now=later
    )
    assert stored(db) == ["AAPL", "MSFT", "NEW"]
    assert db.symbols.count() == 3


# --- Search ranking ------------------------------------------------------------

LISTED = [
    ("MSFT", "MICROSOFT CORP", "Common Stock", "XNAS"),
    ("MU", "MICRON TECHNOLOGY INC", "Common Stock", "XNAS"),
    ("MCHP", "MICROCHIP TECHNOLOGY INC", "Common Stock", "XNAS"),
    ("AMD", "ADVANCED MICRO DEVICES", "Common Stock", "XNAS"),
    ("MS", "MORGAN STANLEY", "Common Stock", "XNYS"),
    ("MSCI", "MSCI INC", "Common Stock", "XNYS"),
    ("AAPL", "APPLE INC", "Common Stock", "XNAS"),
    ("APLE", "APPLE HOSPITALITY REIT INC", "Common Stock", "XNYS"),
    ("A", "AGILENT TECHNOLOGIES INC", "Common Stock", "XNYS"),
    ("AA", "ALCOA CORP", "Common Stock", "XNYS"),
    ("AAL", "AMERICAN AIRLINES GROUP INC", "Common Stock", "XNAS"),
    ("ABNB", "AIRBNB INC-CLASS A", "Common Stock", "XNAS"),
    ("ADBE", "ADOBE INC", "Common Stock", "XNAS"),
    ("VOO", "VANGUARD S&P 500 ETF", "ETP", "ARCX"),
    ("TSM", "TAIWAN SEMICONDUCTOR-SP ADR", "ADR", "XNYS"),
    # A run of ETNs whose names also start with "micro".
    *[
        (t, f"MICROSECTORS {t} 3X LEVERAGED ETN", "ETP", "ARCX")
        for t in ("BNKU", "CARU", "FNGU", "GDXU", "NRGU", "OILU", "SHNY", "WEBL")
    ],
]
OTC = [
    ("MSAAF", "MS ALPHA HOLDINGS", "Common Stock", "OOTC"),
    ("MCRSF", "MICRO SOFT HOLDINGS", "Common Stock", "OOTC"),
]


@pytest.fixture
def searchable(db: Db) -> Db:
    from app.services.market_data.refresh import US_SYMBOLS
    from app.services.market_data.symbols import parse_symbol_list

    entries = [
        {"symbol": t, "description": d, "type": k, "mic": m}
        for t, d, k, m in LISTED + OTC
    ]
    lease = db.states.claim(US_SYMBOLS, policy(), now=T0)
    assert db.symbols.replace_all(
        parse_symbol_list(entries).rows, refresh_id=lease, now=T0
    )
    return db


def tickers(db: Db, query: str, limit: int = 8) -> list[str]:
    return [m.ticker for m in db.symbols.search(query, limit)]


def test_exact_ticker_comes_first(searchable: Db) -> None:
    assert tickers(searchable, "msft")[0] == "MSFT"
    assert tickers(searchable, "VOO")[0] == "VOO"
    assert tickers(searchable, "tsm")[0] == "TSM"  # ADRs are searchable


def test_ticker_prefix_before_names_and_otc_last(searchable: Db) -> None:
    # MS exact; MSCI and MSFT by prefix (listed, by length then A-Z); then
    # the OTC prefix match, though it sorts first alphabetically.
    assert tickers(searchable, "MS") == ["MS", "MSCI", "MSFT", "MSAAF"]


def test_partial_name_finds_microsoft(searchable: Db) -> None:
    found = tickers(searchable, "micro")

    assert len(found) == 8
    # Names starting "micro" (stocks first), then a later word ("Advanced
    # Micro Devices"), then the ETNs; the OTC lookalike is past the cut.
    assert set(found[:3]) == {"MU", "MCHP", "MSFT"}
    assert found[3] == "AMD"
    assert all(
        t in {"BNKU", "CARU", "FNGU", "GDXU", "NRGU", "OILU", "SHNY", "WEBL"}
        for t in found[4:]
    )
    assert "MCRSF" not in found


def test_otc_ranks_after_listed_matches_in_the_same_tier(searchable: Db) -> None:
    found = tickers(searchable, "micro", limit=20)
    listed = {"MU", "MCHP", "MSFT", "AMD", "BNKU", "CARU", "FNGU", "GDXU"}
    listed |= {"NRGU", "OILU", "SHNY", "WEBL"}

    assert found.index("MCRSF") > max(found.index(t) for t in listed)


@pytest.mark.parametrize("typo", ["mircosoft", "microsft", "micrsoft corp"])
def test_typos_find_microsoft(searchable: Db, typo: str) -> None:
    assert tickers(searchable, typo)[0] == "MSFT"


def test_multi_word_and_mixed_case_names(searchable: Db) -> None:
    assert tickers(searchable, "Advanced Micro")[0] == "AMD"
    assert tickers(searchable, "apple")[:2] == ["AAPL", "APLE"]


def test_at_most_eight_results(searchable: Db) -> None:
    assert len(tickers(searchable, "a")) == 8
    assert len(tickers(searchable, "a", limit=3)) == 3


def test_matches_carry_display_names(searchable: Db) -> None:
    match = searchable.symbols.search("msft")[0]

    assert (match.name, match.type, match.exchange) == (
        "Microsoft Corp",
        "stock",
        "XNAS",
    )
    assert searchable.symbols.search("vanguard")[0].type == "etf"


def test_nothing_matches(searchable: Db) -> None:
    assert searchable.symbols.search("zzzzqqq") == []
    assert searchable.symbols.has_any()


def test_a_lost_lease_writes_nothing(db: Db) -> None:
    from app.services.market_data.refresh import US_SYMBOLS

    first = db.states.claim(US_SYMBOLS, policy(), now=T0)
    taken_over = db.states.claim(US_SYMBOLS, policy(), now=T0 + timedelta(minutes=31))
    assert taken_over is not None

    assert db.symbols.replace_all(rows("AAPL"), refresh_id=first, now=T0) is False
    assert stored(db) == []
    assert db.states.get(US_SYMBOLS).refreshing_since is not None
