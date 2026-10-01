"""RAG transcript search routes (HTTP layer only)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path
from fastapi.responses import JSONResponse

from app.models.rag import (
    RagIndexingResponse,
    RagSearchRequest,
    RagSearchResponse,
    RagTickerListResponse,
    RagTickerStatusResponse,
)
from app.services.rag.container import RagComponents, get_rag_components
from app.services.rag.status import get_ticker_status, list_ticker_statuses

router = APIRouter(prefix="/rag", tags=["rag"])

RagDep = Annotated[RagComponents, Depends(get_rag_components)]
TickerPath = Annotated[str, Path(pattern=r"^[A-Za-z][A-Za-z0-9.-]{0,9}$")]

_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    202: {"model": RagIndexingResponse, "description": "Ticker is being indexed"},
    404: {"description": "No transcripts exist for the ticker"},
    429: {"description": "Daily new-ticker ingestion cap reached"},
    502: {"description": "Embedding or vector search failed"},
    503: {"description": "RAG is not configured"},
}


@router.post("/search", response_model=RagSearchResponse, responses=_ERROR_RESPONSES)
def search_transcripts(
    body: RagSearchRequest, rag: RagDep
) -> RagSearchResponse | JSONResponse:
    """Hybrid search over earnings call transcripts.

    Returns 202 with an ``indexing`` status when ``ticker`` is not indexed yet;
    ingestion runs in the background, so poll ``poll_url`` and search again.
    """
    result = rag.search.search(body)
    if isinstance(result, RagIndexingResponse):
        return JSONResponse(status_code=202, content=result.model_dump())
    return result


@router.get("/tickers", response_model=RagTickerListResponse)
def list_tickers(rag: RagDep) -> RagTickerListResponse:
    """Every ticker that has been indexed or attempted."""
    return RagTickerListResponse(tickers=list_ticker_statuses(rag.repo))


@router.get("/tickers/{ticker}", response_model=RagTickerStatusResponse)
def ticker_status(ticker: TickerPath, rag: RagDep) -> RagTickerStatusResponse:
    """Indexing status for one ticker (``not_indexed`` if never requested)."""
    return get_ticker_status(rag.repo, ticker.upper())
