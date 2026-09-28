"""Pydantic models for market-data quotes."""

from datetime import datetime

from pydantic import BaseModel, Field


class Quote(BaseModel):
    """A single market quote for one ticker."""

    ticker: str = Field(description="Uppercase ticker symbol.")
    price: float = Field(description="Latest trade price.")
    previous_close: float = Field(description="Previous session's closing price.")
    change: float = Field(description="Absolute change vs. previous close.")
    change_percent: float = Field(description="Percent change vs. previous close.")
    currency: str = Field(default="USD", description="Quote currency.")
    name: str | None = Field(default=None, description="Company / instrument name.")
    provider: str = Field(description="Provider that served this quote (or 'cache').")
    as_of: datetime = Field(description="When the quote was retrieved (UTC).")

    @classmethod
    def build(
        cls,
        *,
        ticker: str,
        price: float,
        previous_close: float,
        provider: str,
        as_of: datetime,
        currency: str = "USD",
        name: str | None = None,
    ) -> "Quote":
        """Construct a Quote, deriving change and change percent."""
        change = price - previous_close
        change_percent = (change / previous_close * 100) if previous_close else 0.0
        return cls(
            ticker=ticker.upper(),
            price=price,
            previous_close=previous_close,
            change=change,
            change_percent=change_percent,
            currency=currency,
            name=name,
            provider=provider,
            as_of=as_of,
        )


class QuotesResponse(BaseModel):
    """Batch quote response: successful quotes keyed by ticker, plus errors."""

    quotes: dict[str, Quote] = Field(
        default_factory=dict, description="Successful quotes, keyed by ticker."
    )
    errors: dict[str, str] = Field(
        default_factory=dict,
        description="Tickers that could not be resolved, mapped to a reason.",
    )
