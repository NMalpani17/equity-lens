"""Request / response models for the RAG transcript search API."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field, StringConstraints


def _normalize_ticker(value: object) -> object:
    return value.strip().upper() if isinstance(value, str) else value


# Normalized before the pattern check, so " aapl " is accepted as "AAPL".
Ticker = Annotated[
    str,
    BeforeValidator(_normalize_ticker),
    StringConstraints(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$"),
]

TickerStatus = Literal["not_indexed", "indexing", "indexed", "failed", "unavailable"]


class RagSearchRequest(BaseModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)] = (
        Field(max_length=1000)
    )
    ticker: Ticker | None = None
    fiscal_year: int | None = Field(default=None, ge=1990, le=2100)
    fiscal_quarter: int | None = Field(default=None, ge=1, le=4)
    top_k: int = Field(default=5, ge=1, le=20)


class RagFilters(BaseModel):
    ticker: str | None = None
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None


class RagSearchResult(BaseModel):
    """One retrieved chunk with its citation metadata."""

    id: str
    text: str
    # Final ranking score: the rerank score when reranked, else the hybrid score.
    score: float
    retrieval_score: float
    rerank_score: float | None = None
    ticker: str
    company_name: str
    fiscal_year: int
    fiscal_quarter: int
    call_date: str | None = None
    speaker: str
    role: str | None = None
    section: Literal["prepared_remarks", "qa"]
    chunk_index: int
    context_header: str


class RagSearchResponse(BaseModel):
    status: Literal["ok"] = "ok"
    query: str
    filters: RagFilters
    reranked: bool
    candidate_count: int
    results: list[RagSearchResult]
    latency_ms: float


class RagIndexingResponse(BaseModel):
    """Returned (HTTP 202) when the ticker is being indexed; poll ``poll_url``."""

    status: Literal["indexing"] = "indexing"
    ticker: str
    job_id: str | None
    message: str
    poll_url: str


class RagJobInfo(BaseModel):
    id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    trigger: str
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class RagTickerStatusResponse(BaseModel):
    ticker: str
    status: TickerStatus
    company_name: str | None = None
    chunk_count: int = 0
    quarters: list[str] = Field(default_factory=list)
    indexed_at: datetime | None = None
    last_error: str | None = None
    job: RagJobInfo | None = None


class RagTickerListResponse(BaseModel):
    tickers: list[RagTickerStatusResponse]
