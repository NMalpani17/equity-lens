"""In-memory fake of the market data cache, shared by the market tests."""

from collections.abc import Sequence
from datetime import date, datetime

from app.services.market_data.repository import (
    STATUS_NO_HISTORY,
    STATUS_OK,
    Coverage,
    StoredProfile,
)
from app.services.rag.repository import utcnow


class FakeMarketRepository:
    def __init__(self) -> None:
        self.closes_by_ticker: dict[str, dict[date, float]] = {}
        self.coverage_by_ticker: dict[str, Coverage] = {}
        self.replaced: list[str] = []
        self.stored_profiles: dict[str, StoredProfile] = {}

    # --- company profiles -----------------------------------------------

    def profiles(self, tickers: Sequence[str]) -> dict[str, StoredProfile]:
        return {
            t: self.stored_profiles[t] for t in tickers if t in self.stored_profiles
        }

    def save_profile(self, profile: StoredProfile) -> None:
        self.stored_profiles[profile.ticker] = profile

    # --- daily closes ---------------------------------------------------

    def coverage(self, tickers: Sequence[str]) -> dict[str, Coverage]:
        return {
            t: self.coverage_by_ticker[t]
            for t in tickers
            if t in self.coverage_by_ticker
        }

    def closes(
        self, tickers: Sequence[str], start: date
    ) -> dict[str, list[tuple[date, float]]]:
        result: dict[str, list[tuple[date, float]]] = {}
        for ticker in tickers:
            rows = sorted(
                (d, c)
                for d, c in self.closes_by_ticker.get(ticker, {}).items()
                if d >= start
            )
            if rows:
                result[ticker] = rows
        return result

    def save_closes(
        self,
        ticker: str,
        rows: Sequence[tuple[date, float]],
        *,
        covered_from: date,
        fetched_through: date,
        replace: bool,
        now: datetime | None = None,
    ) -> None:
        if replace:
            self.replaced.append(ticker)
            self.closes_by_ticker[ticker] = {}
        self.closes_by_ticker.setdefault(ticker, {}).update(dict(rows))
        self.coverage_by_ticker[ticker] = Coverage(
            ticker, covered_from, fetched_through, STATUS_OK, now or utcnow()
        )

    def mark_no_history(
        self,
        ticker: str,
        *,
        covered_from: date,
        fetched_through: date,
        now: datetime | None = None,
    ) -> None:
        self.coverage_by_ticker[ticker] = Coverage(
            ticker, covered_from, fetched_through, STATUS_NO_HISTORY, now or utcnow()
        )
