"""Pydantic models for company search."""

from typing import Literal

from pydantic import BaseModel, Field


class SymbolMatch(BaseModel):
    ticker: str
    name: str = Field(description='Display name, e.g. "Microsoft Corp".')
    type: Literal["stock", "etf", "adr"]
    exchange: str | None = Field(
        default=None, description='Market identifier code; "OOTC" is over the counter.'
    )


class SymbolSearchResponse(BaseModel):
    results: list[SymbolMatch] = Field(default_factory=list)
    ready: bool = Field(
        description="False while the symbol list hasn't been loaded (or the "
        "database is unreachable); an exact ticker still works then."
    )
