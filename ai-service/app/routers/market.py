"""Market-data routes (HTTP layer only)."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import get_settings
from app.models.quote import Quote, QuotesResponse
from app.services.market_data.base import (
    ProviderUnavailableError,
    QuoteNotFoundError,
)
from app.services.market_data.service import (
    MarketDataService,
    get_market_data_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/quotes", tags=["market"])

ServiceDep = Annotated[MarketDataService, Depends(get_market_data_service)]


def parse_symbols(symbols: str) -> list[str]:
    """Split a comma-separated ``symbols`` query into a clean, unique list."""
    seen: list[str] = []
    for raw in symbols.split(","):
        symbol = raw.strip().upper()
        if symbol and symbol not in seen:
            seen.append(symbol)
    return seen


def checked_symbols(symbols: str) -> list[str]:
    """Parsed symbols, or 422 when there are none or too many."""
    parsed = parse_symbols(symbols)
    if not parsed:
        raise HTTPException(status_code=422, detail="no valid symbols provided")
    limit = get_settings().market_max_symbols
    if len(parsed) > limit:
        raise HTTPException(status_code=422, detail=f"at most {limit} symbols")
    return parsed


@router.get("", response_model=QuotesResponse)
def get_quotes(
    service: ServiceDep,
    symbols: Annotated[
        str, Query(description="Comma-separated ticker symbols, e.g. AAPL,MSFT")
    ],
) -> QuotesResponse:
    """Return quotes for many tickers; per-ticker failures land in ``errors``."""
    parsed = parse_symbols(symbols)
    if not parsed:
        raise HTTPException(status_code=422, detail="no valid symbols provided")
    return service.get_quotes(parsed)


@router.get("/{ticker}", response_model=Quote)
def get_quote(ticker: str, service: ServiceDep) -> Quote:
    """Return a single quote, 404 for unknown tickers, 502 when unavailable."""
    try:
        return service.get_quote(ticker)
    except QuoteNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ProviderUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
