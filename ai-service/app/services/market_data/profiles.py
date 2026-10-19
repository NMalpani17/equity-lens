"""Company profiles for sector allocation, cached in Postgres.

Finnhub's profile is asked first; when it has none (ETFs, foreign listings) or
an industry we can't map, yfinance is the fallback. Profiles are kept for 30
days (unknown tickers for 7). Each request looks up at most a fixed number of
uncached tickers, which bounds its Finnhub calls; the rest come back as
``pending`` and are looked up on a later request.
"""

import logging
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import psycopg
import yfinance as yf

from app.config import get_settings
from app.models.profile import CompanyProfile, ProfilesResponse

from .base import ProviderUnavailableError
from .daily_closes import yahoo_symbol
from .repository import MarketDataRepository, StoredProfile, shared_repository
from .sectors import sector_from_finnhub, sector_from_yahoo
from .service import get_finnhub_provider

logger = logging.getLogger(__name__)

SOURCE_NONE = "none"

# symbol -> provider payload. Raises ProviderUnavailableError.
ProfileFetcher = Callable[[str], dict[str, Any]]
RepositoryProvider = Callable[[], MarketDataRepository | None]


def fetch_yfinance_info(symbol: str) -> dict[str, Any]:
    try:
        return dict(yf.Ticker(yahoo_symbol(symbol)).info or {})
    except Exception as exc:  # yfinance raises assorted network/parse errors
        raise ProviderUnavailableError(f"yfinance info failed: {exc}") from exc


@dataclass(frozen=True)
class _Lookup:
    profile: CompanyProfile
    # False when a provider was down, so "unknown" may just mean "not now".
    cacheable: bool


class ProfileService:
    def __init__(
        self,
        finnhub: ProfileFetcher,
        yfinance: ProfileFetcher,
        repository: RepositoryProvider,
        *,
        ttl: timedelta = timedelta(days=30),
        unknown_ttl: timedelta = timedelta(days=7),
        max_lookups: int = 25,
        max_workers: int = 8,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._finnhub = finnhub
        self._yfinance = yfinance
        self._repository = repository
        self._ttl = ttl
        self._unknown_ttl = unknown_ttl
        self._max_lookups = max_lookups
        self._max_workers = max_workers
        self._clock = clock

    def get_profiles(self, symbols: Sequence[str]) -> ProfilesResponse:
        now = self._clock()
        repo = self._repository()
        stored: dict[str, StoredProfile] = {}
        if repo is not None:
            try:
                stored = repo.profiles(symbols)
            except psycopg.Error as exc:
                logger.warning("company profile cache read failed: %s", exc)
                repo = None

        response = ProfilesResponse()
        due: list[str] = []
        for symbol in symbols:
            row = stored.get(symbol)
            if row is not None:
                response.profiles[symbol] = _to_model(row)
            if row is None or self._expired(row, now):
                due.append(symbol)

        to_look_up = due[: self._max_lookups]
        # Over budget: a stale profile still serves; a missing one is pending.
        response.pending = [s for s in due[self._max_lookups :] if s not in stored]
        if to_look_up:
            workers = min(self._max_workers, len(to_look_up))
            with ThreadPoolExecutor(workers, thread_name_prefix="profiles") as pool:
                lookups = list(pool.map(self._look_up, to_look_up))
            for lookup in lookups:
                profile = lookup.profile
                if lookup.cacheable or profile.ticker not in stored:
                    response.profiles[profile.ticker] = profile
                if lookup.cacheable and repo is not None:
                    self._save(repo, profile, now)
        return response

    def _expired(self, row: StoredProfile, now: datetime) -> bool:
        ttl = self._unknown_ttl if row.sector is None else self._ttl
        return now - row.fetched_at.replace(tzinfo=UTC) >= ttl

    def _look_up(self, symbol: str) -> _Lookup:
        provider_down = False
        name: str | None = None
        industry: str | None = None
        try:
            data = self._finnhub(symbol)
            name = data.get("name") or None
            industry = data.get("finnhubIndustry") or None
            sector = sector_from_finnhub(industry)
            if sector:
                return _Lookup(
                    CompanyProfile(
                        ticker=symbol,
                        name=name,
                        sector=sector,
                        industry=industry,
                        source="finnhub",
                    ),
                    cacheable=True,
                )
        except ProviderUnavailableError as exc:
            logger.info("finnhub profile unavailable for %s: %s", symbol, exc)
            provider_down = True

        try:
            info = self._yfinance(symbol)
            yahoo_sector = info.get("sector") or None
            sector = sector_from_yahoo(yahoo_sector, info.get("quoteType"))
            name = name or info.get("longName") or info.get("shortName") or None
            if sector:
                return _Lookup(
                    CompanyProfile(
                        ticker=symbol,
                        name=name,
                        sector=sector,
                        industry=yahoo_sector or info.get("quoteType"),
                        source="yfinance",
                    ),
                    cacheable=True,
                )
        except ProviderUnavailableError as exc:
            logger.info("yfinance profile unavailable for %s: %s", symbol, exc)
            provider_down = True

        return _Lookup(
            CompanyProfile(
                ticker=symbol, name=name, industry=industry, source=SOURCE_NONE
            ),
            cacheable=not provider_down,
        )

    @staticmethod
    def _save(
        repo: MarketDataRepository, profile: CompanyProfile, now: datetime
    ) -> None:
        try:
            repo.save_profile(
                StoredProfile(
                    ticker=profile.ticker,
                    name=profile.name,
                    sector=profile.sector,
                    industry=profile.industry,
                    source=profile.source,
                    fetched_at=now.astimezone(UTC).replace(tzinfo=None),
                )
            )
        except psycopg.Error as exc:
            logger.warning("company profile cache write failed: %s", exc)


def _to_model(row: StoredProfile) -> CompanyProfile:
    return CompanyProfile(
        ticker=row.ticker,
        name=row.name,
        sector=row.sector,
        industry=row.industry,
        source=row.source,
    )


@lru_cache
def get_profile_service() -> ProfileService:
    settings = get_settings()
    return ProfileService(
        get_finnhub_provider().get_profile,
        fetch_yfinance_info,
        shared_repository,
        ttl=timedelta(days=settings.profile_ttl_days),
        unknown_ttl=timedelta(days=settings.profile_unknown_ttl_days),
        max_lookups=settings.profile_max_lookups_per_request,
        max_workers=settings.market_history_workers,
    )
