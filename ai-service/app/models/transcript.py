"""Domain models for earnings call transcripts (parsed from Equibles JSON)."""

import re
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

_FILER_SUFFIX_RE = re.compile(r"\s*/[A-Za-z]{1,5}$")
# "Nvidia Corp Q1 FY2027 Earnings Call" -> "Nvidia Corp"
_TITLE_COMPANY_RE = re.compile(r"^(?P<company>.+?)\s+Q[1-4]\s+FY\d{4}\b", re.IGNORECASE)


def company_from_event_title(title: str | None) -> str | None:
    """Extract the company name from an Equibles event title, if present."""
    if not title:
        return None
    match = _TITLE_COMPANY_RE.match(title.strip())
    if not match:
        return None
    # Drop SEC filer suffixes such as "/New" or "/DE".
    return _FILER_SUFFIX_RE.sub("", match.group("company")).strip() or None


class EarningsCallEvent(BaseModel):
    """One row of ``GET /stocks/{ticker}/investor-events``."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    event_id: str = Field(alias="id")
    title: str | None = None
    call_date: datetime | None = Field(default=None, alias="callDate")
    fiscal_year: int | None = Field(default=None, alias="fiscalYear")
    fiscal_quarter: int | None = Field(default=None, alias="fiscalQuarter")
    status: str | None = None
    has_transcript: bool = Field(default=False, alias="hasTranscript")

    @property
    def is_ingestible(self) -> bool:
        """True when this event has a transcript and a known fiscal period."""
        return (
            self.has_transcript
            and self.fiscal_year is not None
            and self.fiscal_quarter is not None
        )


class SpeakerTurn(BaseModel):
    """A single speaker turn within a transcript."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    speaker_index: int = Field(alias="speakerIndex")
    speaker_name: str | None = Field(default=None, alias="speakerName")
    speaker_role: str | None = Field(default=None, alias="speakerRole")
    text: str = ""


class Transcript(BaseModel):
    """A full earnings call transcript (all speaker-turn pages merged)."""

    ticker: str
    company_name: str
    event_title: str | None = None
    call_date: date | None = None
    fiscal_year: int
    fiscal_quarter: int
    turns: list[SpeakerTurn]

    @property
    def period_label(self) -> str:
        """Short label such as ``FY2025Q3``."""
        return f"FY{self.fiscal_year}Q{self.fiscal_quarter}"

    @classmethod
    def from_equibles(cls, payload: dict[str, Any]) -> "Transcript":
        """Build a transcript from a (merged) Equibles ``/speakers`` payload."""
        ticker = str(payload["ticker"]).upper()
        title = payload.get("eventTitle")
        raw_date = payload.get("callDate")
        call_date = datetime.fromisoformat(raw_date).date() if raw_date else None
        return cls(
            ticker=ticker,
            company_name=company_from_event_title(title) or ticker,
            event_title=title,
            call_date=call_date,
            fiscal_year=int(payload["fiscalYear"]),
            fiscal_quarter=int(payload["fiscalQuarter"]),
            turns=[SpeakerTurn.model_validate(t) for t in payload.get("data", [])],
        )
