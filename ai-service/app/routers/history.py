"""Daily price history routes (HTTP layer only)."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.models.daily_closes import DailyClosesResponse
from app.routers.market import checked_symbols
from app.services.market_data.daily_closes import (
    DailyClosesService,
    get_daily_closes_service,
)

router = APIRouter(prefix="/history", tags=["market"])

ServiceDep = Annotated[DailyClosesService, Depends(get_daily_closes_service)]


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
