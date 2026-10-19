"""Pydantic models for the batch ticker check (holdings import)."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

Symbol = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12)
]


class TickerCheckRequest(BaseModel):
    symbols: list[Symbol] = Field(min_length=1, max_length=500)


class TickerCheckResponse(BaseModel):
    results: dict[str, Literal["ok", "not_found", "unavailable"]] = Field(
        description='Per uppercase ticker; "unavailable" means it could not be '
        "checked right now."
    )
