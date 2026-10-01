"""Classify Pinecone SDK exceptions as retryable or not."""

from pinecone import (
    ApiError,
    PineconeConnectionError,
    PineconeTimeoutError,
)


def is_retryable_pinecone_error(exc: BaseException) -> bool:
    """429s, 5xx responses, and connection/timeouts are worth retrying."""
    if isinstance(exc, ApiError):
        return exc.status_code == 429 or exc.status_code >= 500
    return isinstance(exc, PineconeConnectionError | PineconeTimeoutError)
