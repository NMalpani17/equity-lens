"""Pinecone hosted reranker (``bge-reranker-v2-m3`` by default).

Any failure (including an exhausted monthly quota) surfaces as
:class:`RerankUnavailableError` so search can fall back to hybrid ranking.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass

from pinecone import Pinecone

from .errors import RerankUnavailableError
from .pinecone_errors import is_retryable_pinecone_error
from .retry import RetryPolicy, retry_call

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RerankedItem:
    index: int  # position in the documents passed to rerank()
    score: float


class PineconeReranker:
    def __init__(self, pc: Pinecone, *, model: str, retry_policy: RetryPolicy) -> None:
        self._pc = pc
        self._model = model
        self._retry_policy = retry_policy

    def rerank(
        self, query: str, documents: Sequence[str], top_n: int
    ) -> list[RerankedItem]:
        if not documents:
            return []

        def call() -> list[RerankedItem]:
            result = self._pc.inference.rerank(
                model=self._model,
                query=query,
                documents=[{"text": d} for d in documents],
                rank_fields=["text"],
                top_n=min(top_n, len(documents)),
                return_documents=False,
                parameters={"truncate": "END"},
            )
            return [
                RerankedItem(index=r.index, score=float(r.score)) for r in result.data
            ]

        try:
            return retry_call(
                call,
                is_retryable=is_retryable_pinecone_error,
                policy=self._retry_policy,
                operation="pinecone rerank",
            )
        except Exception as exc:
            raise RerankUnavailableError(str(exc)) from exc
