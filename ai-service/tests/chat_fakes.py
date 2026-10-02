"""Shared fixtures for chat tests: search results, portfolios, turn contexts."""

from datetime import UTC, date, datetime

from app.models.chat import PortfolioPosition, PortfolioSnapshot, PortfolioTotals
from app.models.rag import RagSearchResult
from app.services.chat.context import TurnContext


def search_result(
    i: int, ticker: str = "NVDA", text: str | None = None
) -> RagSearchResult:
    return RagSearchResult(
        id=f"{ticker}#FY2027Q2#{i:04d}",
        text=text or f"Data center revenue grew strongly, passage {i}.",
        score=0.9,
        retrieval_score=0.5,
        rerank_score=0.9,
        ticker=ticker,
        company_name="Nvidia Corp",
        fiscal_year=2027,
        fiscal_quarter=2,
        call_date="2026-08-26",
        speaker="Colette Kress",
        role="CFO",
        section="prepared_remarks",
        chunk_index=i,
        context_header="NVDA (Nvidia Corp) · Q2 FY2027 earnings call",
    )


def portfolio(*positions: PortfolioPosition) -> PortfolioSnapshot:
    value = sum(p.market_value or 0 for p in positions)
    cost = sum(p.cost_basis for p in positions)
    return PortfolioSnapshot(
        positions=list(positions),
        totals=PortfolioTotals(
            market_value=value,
            cost_basis=cost,
            gain_loss=value - cost,
            gain_loss_percent=round((value - cost) / cost * 100, 2) if cost else 0,
        ),
        as_of=datetime(2026, 10, 1, 15, 0, tzinfo=UTC),
    )


def position(ticker: str, shares: float, avg: float, price: float) -> PortfolioPosition:
    return PortfolioPosition(
        ticker=ticker,
        total_shares=shares,
        avg_buy_price=avg,
        cost_basis=shares * avg,
        current_price=price,
        market_value=shares * price,
        gain_loss=shares * (price - avg),
        gain_loss_percent=round((price - avg) / avg * 100, 2),
    )


def turn(snapshot: PortfolioSnapshot | None = None) -> TurnContext:
    return TurnContext(
        user_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        is_anonymous=False,
        today=date(2026, 10, 1),
        portfolio=snapshot,
    )
