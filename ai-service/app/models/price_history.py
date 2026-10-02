"""Pydantic models for historical prices."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

HistoryPeriod = Literal["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y"]


class PricePoint(BaseModel):
    date: date
    close: float


class PriceHistory(BaseModel):
    """Summary statistics plus a downsampled close series for one ticker."""

    ticker: str
    period: HistoryPeriod
    interval: Literal["1d", "1wk"]
    currency: str = "USD"
    start_date: date
    end_date: date
    first_close: float
    last_close: float
    change: float
    change_percent: float
    high: float
    high_date: date
    low: float
    low_date: date
    points: list[PricePoint] = Field(
        description="Closes downsampled to at most ~60 points (first and last kept)."
    )
    provider: str
    as_of: datetime
