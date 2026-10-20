"""Earnings calendar routes (HTTP layer only)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.models.earnings import UpcomingEarningsRequest, UpcomingEarningsResponse
from app.services.market_data.earnings import EarningsService, get_earnings_service

router = APIRouter(prefix="/earnings", tags=["market"])

ServiceDep = Annotated[EarningsService, Depends(get_earnings_service)]


@router.post("/upcoming", response_model=UpcomingEarningsResponse)
def upcoming_earnings(
    body: UpcomingEarningsRequest, service: ServiceDep
) -> UpcomingEarningsResponse:
    """Each ticker's next earnings report within ``days`` (no Finnhub calls).

    A calendar older than a day is reloaded in the background meanwhile.
    """
    return service.upcoming(body.symbols, body.days)
