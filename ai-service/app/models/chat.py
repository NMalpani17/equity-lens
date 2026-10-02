"""Request / event models for the AI analyst chat."""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

from app.localtime import valid_time_zone

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class PortfolioPosition(BaseModel):
    """One position (lots grouped by ticker), as computed by the API gateway."""

    ticker: str
    name: str | None = None
    total_shares: float
    avg_buy_price: float
    cost_basis: float
    current_price: float | None = None
    market_value: float | None = None
    gain_loss: float | None = None
    gain_loss_percent: float | None = None
    daily_change: float | None = None
    daily_change_percent: float | None = None
    price_status: Literal["ok", "not_found", "unavailable"] = "ok"


class PortfolioTotals(BaseModel):
    market_value: float = 0.0
    cost_basis: float = 0.0
    gain_loss: float = 0.0
    gain_loss_percent: float = 0.0
    daily_change: float = 0.0
    partial: bool = False


class PortfolioSnapshot(BaseModel):
    """The user's portfolio at the start of the turn (sent by the gateway)."""

    positions: list[PortfolioPosition] = Field(default_factory=list)
    totals: PortfolioTotals = Field(default_factory=PortfolioTotals)
    as_of: datetime | None = None


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20000)


class ChatTurnRequest(BaseModel):
    """One chat turn. Only the API gateway (internal token) may send this.

    ``user_id`` comes from the gateway's verified JWT, never from a browser.
    """

    user_id: str = Field(min_length=1, max_length=64)
    is_anonymous: bool = False
    conversation_id: str | None = Field(default=None, max_length=64)
    message: NonEmptyText
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=50)
    portfolio: PortfolioSnapshot | None = None
    today: date | None = None
    # The user's IANA time zone from the browser; invalid values fall back to UTC.
    time_zone: str | None = Field(default=None, max_length=64)

    @field_validator("time_zone", mode="before")
    @classmethod
    def _known_zone(cls, value: object) -> str | None:
        return valid_time_zone(value)


class Citation(BaseModel):
    """A validated citation: an [n] marker mapped to a retrieved passage."""

    id: int
    ticker: str
    company_name: str
    fiscal_year: int
    fiscal_quarter: int
    call_date: str | None = None
    speaker: str
    role: str | None = None
    section: str
    text: str


class ToolCallSummary(BaseModel):
    id: str
    name: str
    label: str
    args: dict = Field(default_factory=dict)
    ok: bool | None = None
    summary: str | None = None


TurnStatus = Literal["complete", "truncated", "blocked", "empty", "refused"]


# --- Inline charts -------------------------------------------------------------
# Built only from tool results (never from model-written numbers) and rendered
# by the client next to the answer.


class ChartPoint(BaseModel):
    date: date
    close: float


class PriceChart(BaseModel):
    """A ticker's closing prices over a period (from get_price_history)."""

    id: str
    kind: Literal["price_history"] = "price_history"
    ticker: str
    period: str
    currency: str = "USD"
    points: list[ChartPoint] = Field(min_length=2)
    first_close: float
    last_close: float
    change: float
    change_percent: float
    high: float
    low: float
    as_of: str | None = None


class AllocationSlice(BaseModel):
    ticker: str
    name: str | None = None
    market_value: float
    weight_percent: float


class AllocationChart(BaseModel):
    """The user's holdings by market value (from get_portfolio)."""

    id: str
    kind: Literal["portfolio_allocation"] = "portfolio_allocation"
    currency: str = "USD"
    slices: list[AllocationSlice] = Field(min_length=1)
    total_market_value: float
    # True when some positions had no price and are left out.
    partial: bool = False
    as_of: str | None = None


ChatChart = Annotated[PriceChart | AllocationChart, Field(discriminator="kind")]
