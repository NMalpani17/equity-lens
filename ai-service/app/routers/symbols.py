"""Company search routes (HTTP layer only)."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.models.symbol import SymbolSearchResponse
from app.services.market_data.symbols import (
    MAX_RESULTS,
    SymbolService,
    get_symbol_service,
)

router = APIRouter(prefix="/symbols", tags=["market"])

ServiceDep = Annotated[SymbolService, Depends(get_symbol_service)]


@router.get("/search", response_model=SymbolSearchResponse)
def search_symbols(
    service: ServiceDep,
    q: Annotated[str, Query(min_length=1, max_length=50, description="Name or ticker")],
    limit: Annotated[int, Query(ge=1, le=MAX_RESULTS)] = MAX_RESULTS,
) -> SymbolSearchResponse:
    """US stocks, ETFs and ADRs matching ``q``, best first. No Finnhub calls.

    A list older than a day is refreshed in the background meanwhile.
    """
    return service.search(q, limit)
