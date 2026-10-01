"""RAG domain errors.

Errors that should reach clients subclass :class:`app.errors.AppError`, which
the centralized handler in ``app.main`` maps to a JSON response.
"""

from datetime import datetime

from app.errors import AppError


class RagNotConfiguredError(AppError):
    """Required keys / DATABASE_URL are missing."""

    def __init__(self, missing: list[str]) -> None:
        super().__init__(
            503,
            "rag_not_configured",
            "transcript search is not configured",
            {"missing": missing},
        )


class IngestionCapReachedError(AppError):
    """The daily cap on new-ticker ingestions has been reached."""

    def __init__(self, ticker: str, cap: int, resets_at: datetime) -> None:
        super().__init__(
            429,
            "ingestion_cap_reached",
            f"daily limit of {cap} new tickers reached; {ticker} can be indexed "
            f"after {resets_at.isoformat()}",
            {"ticker": ticker, "cap": cap, "resets_at": resets_at.isoformat()},
        )


class TickerUnavailableError(AppError):
    """No earnings call transcripts exist for the ticker."""

    def __init__(self, ticker: str) -> None:
        super().__init__(
            404,
            "transcripts_unavailable",
            f"no earnings call transcripts are available for {ticker}",
            {"ticker": ticker},
        )


class SearchUpstreamError(AppError):
    """Embedding or vector search failed after retries."""

    def __init__(self, message: str) -> None:
        super().__init__(502, "upstream_error", message)


# --- Internal errors (handled inside the service, never sent as-is) ---


class EquiblesError(Exception):
    """Equibles returned an error or was unreachable."""


class EquiblesQuotaError(EquiblesError):
    """Equibles' daily request quota is exhausted (HTTP 429)."""


class EmbeddingQuotaExhaustedError(Exception):
    """The embedding provider's *daily* quota is used up; retrying won't help."""


class EquiblesNotFoundError(EquiblesError):
    """Equibles has no such ticker / quarter (HTTP 404)."""


class NoTranscriptsError(Exception):
    """A ticker has no ingestible transcripts."""


class RerankUnavailableError(Exception):
    """The reranker failed or its quota is exhausted."""
