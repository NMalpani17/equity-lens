"""Daily price history routes (HTTP layer only)."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.models.daily_closes import DailyClosesResponse
from app.routers.market import parse_symbols
from app.services.market_data.daily_closes import (
    DailyClosesService,
    get_daily_closes_service,
)

router = APIRouter(prefix="/history", tags=["market"])

ServiceDep = Annotated[DailyClosesService, Depends(get_daily_closes_service)]


def checked_symbols(symbols: str) -> list[str]:
    """Parsed symbols, or 422 when there are none or too many."""
    parsed = parse_symbols(symbols)
    if not parsed:
        raise HTTPException(status_code=422, detail="no valid symbols provided")
    limit = get_settings().market_max_symbols
    if len(parsed) > limit:
        raise HTTPException(status_code=422, detail=f"at most {limit} symbols")
    return parsed


@router.get("/daily", response_model=DailyClosesResponse)
def get_daily_closes(
    service: ServiceDep,
    symbols: Annotated[
        str, Query(description="Comma-separated ticker symbols, e.g. AAPL,SPY")
    ],
    start: Annotated[date, Query(description="First date wanted (YYYY-MM-DD).")],
) -> DailyClosesResponse:
    """Split-adjusted daily closes from ``start``; tickers without any land in
    ``errors``."""
    return service.get_closes(checked_symbols(symbols), start)
