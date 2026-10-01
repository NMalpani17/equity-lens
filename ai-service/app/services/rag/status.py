"""Builds ticker indexing-status responses (what clients poll)."""

from app.models.rag import RagJobInfo, RagTickerStatusResponse

from .repository import RagRepository, TickerRecord


def _to_response(
    repo: RagRepository, record: TickerRecord, *, include_job: bool
) -> RagTickerStatusResponse:
    job = (
        repo.get_job(record.last_job_id) if include_job and record.last_job_id else None
    )
    return RagTickerStatusResponse(
        ticker=record.ticker,
        status=record.status,
        company_name=record.company_name,
        chunk_count=record.chunk_count,
        quarters=record.quarters,
        indexed_at=record.indexed_at,
        last_error=record.last_error,
        job=RagJobInfo(**job.__dict__) if job else None,
    )


def get_ticker_status(repo: RagRepository, ticker: str) -> RagTickerStatusResponse:
    record = repo.get_ticker(ticker)
    if record is None:
        return RagTickerStatusResponse(ticker=ticker, status="not_indexed")
    return _to_response(repo, record, include_job=True)


def list_ticker_statuses(repo: RagRepository) -> list[RagTickerStatusResponse]:
    return [_to_response(repo, r, include_job=False) for r in repo.list_tickers()]
