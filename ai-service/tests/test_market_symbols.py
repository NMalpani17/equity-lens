"""The US symbol list: download, parsing, display names and refresh policy."""

from datetime import datetime, timedelta

import httpx
import pytest

from app.services.market_data.base import ProviderUnavailableError
from app.services.market_data.finnhub import FinnhubProvider
from app.services.market_data.refresh import (
    US_SYMBOLS,
    BackgroundRefresher,
    RefreshPolicy,
    RefreshState,
    is_due,
)
from app.services.market_data.symbols import (
    MIN_SYMBOLS,
    SymbolService,
    display_name,
    normalize_search,
    parse_symbol_list,
)
from app.services.rag.rate_limit import SlidingWindowLimiter

NOW = datetime(2026, 10, 19, 15, 0)
POLICY = RefreshPolicy(
    max_age=timedelta(hours=24),
    retry_after=timedelta(minutes=30),
    stale_after=timedelta(minutes=10),
)
SIGNED = "https://static2.finnhub.io/file/x/exchange/USf.json?sig=secret"


def entry(symbol: str, description: str, kind: str = "Common Stock", mic="XNAS"):
    return {"symbol": symbol, "description": description, "type": kind, "mic": mic}


# --- Finnhub download --------------------------------------------------------


class FakeGet:
    """Records every httpx.get call; answers the API call, then the file."""

    def __init__(self, api: httpx.Response, file: httpx.Response | None = None):
        self.api, self.file = api, file
        self.calls: list[dict] = []

    def __call__(self, url, params=None, headers=None, timeout=None, **kwargs):
        self.calls.append({"url": str(url), "headers": headers, **kwargs})
        return self.api if len(self.calls) == 1 else self.file


def test_follows_the_redirect_without_the_token(monkeypatch) -> None:
    rows = [entry("MSFT", "MICROSOFT CORP")]
    fake = FakeGet(
        httpx.Response(302, headers={"location": SIGNED}),
        httpx.Response(200, json=rows),
    )
    monkeypatch.setattr(httpx, "get", fake)

    assert FinnhubProvider("key").get_symbol_list() == rows
    api, file = fake.calls
    assert api["headers"] == {"X-Finnhub-Token": "key"}
    assert file["url"] == SIGNED
    assert file["headers"] is None
    assert file["follow_redirects"] is False


@pytest.mark.parametrize(
    "location",
    ["https://evil.example.com/USf.json", "http://static2.finnhub.io/USf.json"],
)
def test_refuses_a_redirect_off_finnhub_https(monkeypatch, location) -> None:
    fake = FakeGet(httpx.Response(302, headers={"location": location}))
    monkeypatch.setattr(httpx, "get", fake)

    with pytest.raises(ProviderUnavailableError):
        FinnhubProvider("key").get_symbol_list()
    assert len(fake.calls) == 1


def test_a_failed_download_never_reports_the_signed_url(monkeypatch) -> None:
    def get(url, params=None, headers=None, timeout=None, **kwargs):
        if params is not None:
            return httpx.Response(302, headers={"location": SIGNED})
        raise httpx.ConnectError(f"cannot reach {url}")

    monkeypatch.setattr(httpx, "get", get)

    with pytest.raises(ProviderUnavailableError) as raised:
        FinnhubProvider("key").get_symbol_list()
    assert "sig=" not in str(raised.value)
    assert raised.value.__cause__ is None


def test_the_list_call_uses_the_shared_budget(monkeypatch) -> None:
    fake = FakeGet(httpx.Response(200, json=[]))
    monkeypatch.setattr(httpx, "get", fake)
    limiter = SlidingWindowLimiter(1)
    assert limiter.try_acquire()

    with pytest.raises(ProviderUnavailableError):
        FinnhubProvider("key", limiter=limiter).get_symbol_list()
    assert fake.calls == []


# --- Parsing and names ---------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("MICROSOFT CORP", "Microsoft Corp"),
        ("ADVANCED MICRO DEVICES", "Advanced Micro Devices"),
        ("SS SPDR S&P 500 ETF TRUST-US", "SS SPDR S&P 500 ETF Trust-US"),
        ("BANK OF AMERICA CORP", "Bank of America Corp"),
        ("BERKSHIRE HATHAWAY INC-CL B", "Berkshire Hathaway Inc-Cl B"),
        ("AMAZON.COM INC", "Amazon.com Inc"),
        ("ISHARES CORE S&P 500 ETF", "iShares Core S&P 500 ETF"),
        ("JPMORGAN CHASE & CO", "JPMorgan Chase & Co"),
        ("THE TRADE DESK INC-CLASS A", "The Trade Desk Inc-Class A"),
    ],
)
def test_display_name(raw: str, expected: str) -> None:
    assert display_name(raw, "X") == expected


def test_display_name_falls_back_to_the_ticker() -> None:
    assert display_name("", "ZZZ") == "ZZZ"


def test_normalize_search() -> None:
    assert normalize_search("Amazon.com, Inc.") == "amazon com inc"
    assert normalize_search("  S&P 500 ") == "s&p 500"


def test_parse_keeps_stocks_etfs_and_adrs_only() -> None:
    rows = parse_symbol_list(
        [
            entry("MSFT", "MICROSOFT CORP"),
            entry("VOO", "VANGUARD S&P 500 ETF", "ETP", "ARCX"),
            entry("TSM", "TAIWAN SEMICONDUCTOR-SP ADR", "ADR", "XNYS"),
            entry("O", "REALTY INCOME CORP", "REIT", "XNYS"),
            entry("ABCDW", "SOME WARRANT", "Equity WRT"),
            entry("XYZ", "NO TYPE", ""),
            entry("NSRGY", "NESTLE SA-SPONS ADR", "ADR", "OOTC"),
        ]
    )

    assert [(r.ticker, r.type, r.exchange) for r in rows] == [
        ("MSFT", "stock", "XNAS"),
        ("VOO", "etf", "ARCX"),
        ("TSM", "adr", "XNYS"),
        ("NSRGY", "adr", "OOTC"),
    ]
    assert rows[0].name == "Microsoft Corp"
    assert rows[0].name_raw == "MICROSOFT CORP"
    assert rows[0].search_name == "microsoft corp"


def test_parse_drops_bad_tickers_and_duplicates() -> None:
    rows = parse_symbol_list(
        [
            entry("BRK.B", "BERKSHIRE HATHAWAY INC-CL B"),
            entry("msft", "MICROSOFT CORP"),
            entry("MSFT", "DUPLICATE"),
            entry("1ABC", "STARTS WITH A DIGIT"),
            entry("TOOLONGTICKER", "TOO LONG"),
            entry("", "EMPTY"),
            "not a dict",
        ]
    )

    assert [r.ticker for r in rows] == ["BRK.B", "MSFT"]
    assert rows[1].name == "Microsoft Corp"


# --- Refresh policy --------------------------------------------------------------


def state(**fields) -> RefreshState:
    base = dict(
        dataset=US_SYMBOLS,
        refreshed_at=None,
        attempted_at=None,
        refreshing_since=None,
        row_count=0,
        covered_from=None,
        covered_to=None,
        last_error=None,
    )
    return RefreshState(**{**base, **fields})


@pytest.mark.parametrize(
    ("current", "due"),
    [
        (None, True),
        (state(), True),
        (state(refreshed_at=NOW - timedelta(hours=23), attempted_at=NOW), False),
        (state(refreshed_at=NOW - timedelta(hours=25)), True),
        # A live refresh holds the lease; a dead one doesn't.
        (state(refreshing_since=NOW - timedelta(minutes=5)), False),
        (state(refreshing_since=NOW - timedelta(minutes=11)), True),
        # A failure backs off for 30 minutes.
        (state(attempted_at=NOW - timedelta(minutes=20)), False),
        (state(attempted_at=NOW - timedelta(minutes=31)), True),
        (
            state(
                refreshed_at=NOW - timedelta(days=2),
                attempted_at=NOW - timedelta(minutes=5),
            ),
            False,
        ),
    ],
)
def test_is_due(current: RefreshState | None, due: bool) -> None:
    assert is_due(current, NOW, POLICY) is due


# --- Refresh service -------------------------------------------------------------


class FakeStates:
    def __init__(self, current: RefreshState | None = None, claim: str | None = "r1"):
        self.current = current
        self.claim_id = claim
        self.claims = 0
        self.failures: list[str] = []

    def get(self, dataset: str) -> RefreshState | None:
        return self.current

    def claim(self, dataset: str, policy: RefreshPolicy, *, now=None) -> str | None:
        self.claims += 1
        return self.claim_id

    def fail(self, dataset: str, refresh_id: str, error: str) -> None:
        self.failures.append(error)


class FakeSymbols:
    def __init__(self, stored: int = 0, keep_lease: bool = True):
        self.stored = stored
        self.keep_lease = keep_lease
        self.replaced: list | None = None

    def count(self) -> int:
        return self.stored

    def replace_all(self, rows, *, refresh_id: str, now: datetime) -> bool:
        if self.keep_lease:
            self.replaced = list(rows)
        return self.keep_lease


class InlineRefresher(BackgroundRefresher):
    """Runs jobs on the caller's thread and counts submissions."""

    def __init__(self) -> None:
        super().__init__(max_workers=1)
        self.submitted = 0

    def submit(self, dataset, job) -> bool:
        self.submitted += 1
        job()
        return True


def full_list(n: int = MIN_SYMBOLS) -> list[dict]:
    return [entry(f"A{i}", f"COMPANY {i}") for i in range(n)]


def make_service(states, symbols, fetch, refresher=None, clock=lambda: NOW):
    return SymbolService(
        fetch_list=fetch,
        states=lambda: states,
        symbols=lambda: symbols,
        refresher=refresher or InlineRefresher(),
        policy=POLICY,
        clock=clock,
    )


def test_refresh_replaces_the_list() -> None:
    states, symbols = FakeStates(), FakeSymbols()

    assert make_service(states, symbols, full_list).refresh() is True
    assert len(symbols.replaced) == MIN_SYMBOLS
    assert states.failures == []


def test_refresh_does_nothing_without_the_lease() -> None:
    fetched: list[int] = []
    states = FakeStates(claim=None)

    service = make_service(states, FakeSymbols(), lambda: fetched.append(1) or [])

    assert service.refresh() is False
    assert fetched == []


def test_finnhub_down_keeps_the_old_list() -> None:
    def down() -> list[dict]:
        raise ProviderUnavailableError("finnhub server error: 503")

    states, symbols = FakeStates(), FakeSymbols(stored=25_000)

    assert make_service(states, symbols, down).refresh() is False
    assert symbols.replaced is None
    assert states.failures == ["finnhub server error: 503"]


def test_a_suspiciously_short_list_never_replaces_the_stored_one() -> None:
    states, symbols = FakeStates(), FakeSymbols(stored=25_000)

    assert make_service(states, symbols, lambda: full_list(5_000)).refresh() is False
    assert symbols.replaced is None
    assert "expected at least 12500" in states.failures[0]


def test_a_lost_lease_writes_nothing() -> None:
    states, symbols = FakeStates(), FakeSymbols(keep_lease=False)

    assert make_service(states, symbols, full_list).refresh() is False
    assert symbols.replaced is None


def test_ensure_fresh_reads_the_state_at_most_once_a_minute() -> None:
    clock = [NOW]
    fresh = state(refreshed_at=NOW - timedelta(hours=1), attempted_at=NOW)
    states, refresher = FakeStates(fresh), InlineRefresher()
    service = make_service(
        states, FakeSymbols(), full_list, refresher, clock=lambda: clock[0]
    )

    service.ensure_fresh()
    states.current = None  # stale now, but not re-read within the minute
    service.ensure_fresh()
    assert refresher.submitted == 0

    clock[0] = NOW + timedelta(seconds=61)
    service.ensure_fresh()
    assert refresher.submitted == 1


def test_background_refresher_runs_one_job_per_dataset() -> None:
    import threading

    refresher = BackgroundRefresher(max_workers=2)
    release, started = threading.Event(), threading.Event()
    runs: list[str] = []

    def job() -> None:
        runs.append("run")
        started.set()
        release.wait(5)

    try:
        assert refresher.submit(US_SYMBOLS, job) is True
        started.wait(5)
        assert refresher.submit(US_SYMBOLS, job) is False
        release.set()
    finally:
        refresher.shutdown()
    assert runs == ["run"]
