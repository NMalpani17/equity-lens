"""Pydantic models for company profiles (sector allocation)."""

from pydantic import BaseModel, Field


class CompanyProfile(BaseModel):
    ticker: str
    name: str | None = None
    sector: str | None = Field(
        default=None,
        description='One of 11 GICS sectors or "Funds"; null when unknown.',
    )
    industry: str | None = Field(
        default=None, description="The provider's own label, before mapping."
    )
    source: str = Field(description='"finnhub", "yfinance" or "none".')


class ProfilesResponse(BaseModel):
    profiles: dict[str, CompanyProfile] = Field(default_factory=dict)
    pending: list[str] = Field(
        default_factory=list,
        description="Not looked up yet (per-request lookup budget); ask again.",
    )
