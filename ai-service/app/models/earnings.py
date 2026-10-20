"""Pydantic models for the earnings calendar."""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

Symbol = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12)
]
EarningsHour = Literal["bmo", "amc", "dmh"]


class UpcomingEarningsRequest(BaseModel):
    symbols: list[Symbol] = Field(min_length=1, max_length=500)
    days: int = Field(default=60, ge=1, le=60)


class EarningsEvent(BaseModel):
    ticker: str
    date: date
    hour: EarningsHour | None = Field(
        default=None,
        description='"bmo" before market open, "amc" after close, "dmh" during '
        "market hours; null when not announced.",
    )
    eps_estimate: float | None = None
    revenue_estimate: float | None = None
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None


class UpcomingEarningsResponse(BaseModel):
    earnings: list[EarningsEvent] = Field(
        default_factory=list,
        description="The next report per ticker in the window, soonest first.",
    )
    unscheduled: list[str] = Field(
        default_factory=list,
        description="Tickers with no report scheduled in the window.",
    )
    window_start: date
    window_end: date
    refreshed_at: datetime | None = None
    refreshing: bool = Field(
        default=False, description="The calendar is loading or being updated."
    )
    available: bool = Field(
        default=True, description="False when the calendar couldn't be read."
    )
