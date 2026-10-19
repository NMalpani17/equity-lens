"""Company profile routes (HTTP layer only)."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.models.profile import ProfilesResponse
from app.routers.market import checked_symbols
from app.services.market_data.profiles import ProfileService, get_profile_service

router = APIRouter(prefix="/profiles", tags=["market"])

ServiceDep = Annotated[ProfileService, Depends(get_profile_service)]


@router.get("", response_model=ProfilesResponse)
def get_profiles(
    service: ServiceDep,
    symbols: Annotated[
        str, Query(description="Comma-separated ticker symbols, e.g. AAPL,VOO")
    ],
) -> ProfilesResponse:
    """Sector and name per ticker; tickers past the lookup budget are pending."""
    return service.get_profiles(checked_symbols(symbols))
