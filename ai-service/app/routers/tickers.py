"""Batch ticker check routes (HTTP layer only)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.models.ticker_check import TickerCheckRequest, TickerCheckResponse
from app.services.market_data.tickers import TickerVerifier, get_ticker_verifier

router = APIRouter(prefix="/tickers", tags=["market"])

VerifierDep = Annotated[TickerVerifier, Depends(get_ticker_verifier)]


@router.post("/verify", response_model=TickerCheckResponse)
def verify_tickers(
    body: TickerCheckRequest, verifier: VerifierDep
) -> TickerCheckResponse:
    """Which tickers exist, for importing many holdings at once.

    Duplicates are checked once. Finnhub is used only while yfinance is down,
    and then for a bounded number of tickers.
    """
    return TickerCheckResponse(results=verifier.verify(body.symbols))
