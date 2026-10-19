"""Pydantic models for daily closes (portfolio performance)."""

from datetime import date

from pydantic import BaseModel, Field

from app.models.price_history import PricePoint


class DailyClosesResponse(BaseModel):
    """Daily closes per ticker, plus tickers that have none."""

    series: dict[str, list[PricePoint]] = Field(
        default_factory=dict,
        description="Split-adjusted closes (price return), oldest first.",
    )
    errors: dict[str, str] = Field(
        default_factory=dict,
        description='Tickers without closes: "not_found" or "unavailable".',
    )
    through: date = Field(
        description="Last completed trading session (New York) the series cover."
    )
