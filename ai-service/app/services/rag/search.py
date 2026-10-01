"""Hybrid retrieval + reranking over indexed transcript chunks.

Flow: (ticker gate) -> embed query (dense + sparse, cached) -> one Pinecone
query with metadata pre-filters and alpha-weighted hybrid vectors ->
rerank candidates -> top_k. Reranking is best-effort: on failure the hybrid
order is returned with ``reranked: false``.
"""

import logging
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.models.rag import (
    RagFilters,
    RagIndexingResponse,
    RagSearchRequest,
    RagSearchResponse,
    RagSearchResult,
)

from .cache import TTLCache
from .embeddings import DenseEmbedder, SparseEncoder, SparseVector
from .errors import RerankUnavailableError, SearchUpstreamError
from .jobs import IngestionCoordinator
from .repository import ClaimOutcome, RagRepository, TickerRecord
from .reranker import PineconeReranker, RerankedItem
from .vector_store import PineconeVectorStore, SearchHit

logger = logging.getLogger(__name__)


class RetrievalMode(StrEnum):
    DENSE = "dense"
    HYBRID = "hybrid"
    HYBRID_RERANK = "hybrid_rerank"


def build_filter(filters: RagFilters) -> dict[str, Any] | None:
    """Pinecone metadata filter for the requested scope (None when unscoped)."""
    clauses = {
        key: {"$eq": value}
        for key, value in filters.model_dump().items()
        if value is not None
    }
    return clauses or None


def hybrid_scale(
    dense: list[float], sparse: SparseVector, alpha: float
) -> tuple[list[float], SparseVector]:
    """Convex combination: dense weighted by alpha, sparse by (1 - alpha)."""
    if not 0 <= alpha <= 1:
        raise ValueError("alpha must be between 0 and 1")
    return [v * alpha for v in dense], sparse.scaled(1 - alpha)


def is_searchable(record: TickerRecord | None) -> bool:
    """Indexed now, or indexed before (a re-index keeps old vectors live)."""
    return record is not None and (
        record.status == "indexed" or record.indexed_at is not None
    )


@dataclass
class _Timer:
    started: float = field(default_factory=time.perf_counter)
    stages: dict[str, float] = field(default_factory=dict)
    _last: float = 0.0

    def __post_init__(self) -> None:
        self._last = self.started

    def lap(self, stage: str) -> None:
        now = time.perf_counter()
        self.stages[stage] = round((now - self._last) * 1000, 1)
        self._last = now

    @property
    def total_ms(self) -> float:
        return round((time.perf_counter() - self.started) * 1000, 1)


class RagSearchService:
    def __init__(
        self,
        repo: RagRepository,
        coordinator: IngestionCoordinator,
        embedder: DenseEmbedder,
        sparse_encoder: SparseEncoder,
        store: PineconeVectorStore,
        reranker: PineconeReranker,
        *,
        rerank_cache: TTLCache[list[RerankedItem]],
        namespace: str,
        candidate_k: int,
        alpha: float,
    ) -> None:
        self._repo = repo
        self._coordinator = coordinator
        self._embedder = embedder
        self._sparse = sparse_encoder
        self._store = store
        self._reranker = reranker
        self._rerank_cache = rerank_cache
        self._namespace = namespace
        self._candidate_k = candidate_k
        self._alpha = alpha

    def search(
        self, request: RagSearchRequest
    ) -> RagSearchResponse | RagIndexingResponse:
        """Search, or start indexing when the requested ticker isn't indexed."""
        if request.ticker and not is_searchable(self._repo.get_ticker(request.ticker)):
            claim = self._coordinator.request_on_demand(request.ticker)
            if claim.outcome is not ClaimOutcome.ALREADY_INDEXED:
                return RagIndexingResponse(
                    ticker=request.ticker,
                    job_id=claim.job_id,
                    message=(
                        f"{request.ticker} transcripts are being indexed; "
                        "poll the status URL and retry the search when indexed"
                    ),
                    poll_url=f"/rag/tickers/{request.ticker}",
                )
        return self.retrieve(request)

    def retrieve(
        self,
        request: RagSearchRequest,
        *,
        mode: RetrievalMode = RetrievalMode.HYBRID_RERANK,
        namespace: str | None = None,
        with_header: bool = True,
    ) -> RagSearchResponse:
        """Run retrieval only (no ticker gate). Used directly by evaluation."""
        timer = _Timer()
        filters = RagFilters(
            ticker=request.ticker,
            fiscal_year=request.fiscal_year,
            fiscal_quarter=request.fiscal_quarter,
        )
        try:
            dense = self._embedder.embed_query(request.query)
            sparse = (
                None
                if mode is RetrievalMode.DENSE
                else self._sparse.encode_query(request.query)
            )
            timer.lap("embed_ms")
            if sparse is not None:
                dense, sparse = hybrid_scale(dense, sparse, self._alpha)
            candidates = self._store.query(
                dense=dense,
                sparse=sparse,
                metadata_filter=build_filter(filters),
                top_k=self._candidate_k,
                namespace=namespace or self._namespace,
            )
            timer.lap("query_ms")
        except Exception as exc:
            logger.exception("rag retrieval failed")
            raise SearchUpstreamError(
                "transcript search is temporarily unavailable"
            ) from exc

        reranked = False
        ranked: list[tuple[SearchHit, float | None]]
        if mode is RetrievalMode.HYBRID_RERANK and candidates:
            items = self._rerank(request, candidates, with_header=with_header)
            if items is not None:
                ranked = [(candidates[i.index], i.score) for i in items]
                reranked = True
            timer.lap("rerank_ms")
        if not reranked:
            ranked = [(hit, None) for hit in candidates[: request.top_k]]

        results = [_to_result(hit, rerank_score) for hit, rerank_score in ranked]
        logger.info(
            "rag search",
            extra={
                "fields": {
                    "event": "rag_search",
                    "filters": filters.model_dump(exclude_none=True),
                    "mode": mode.value,
                    "candidate_count": len(candidates),
                    "returned": len(results),
                    "reranked": reranked,
                    "latency_ms": timer.total_ms,
                    **timer.stages,
                }
            },
        )
        return RagSearchResponse(
            query=request.query,
            filters=filters,
            reranked=reranked,
            candidate_count=len(candidates),
            results=results,
            latency_ms=timer.total_ms,
        )

    def _rerank(
        self,
        request: RagSearchRequest,
        candidates: list[SearchHit],
        *,
        with_header: bool,
    ) -> list[RerankedItem] | None:
        """Reranked order, or None when the reranker is unavailable."""
        key = (
            request.query,
            tuple(c.id for c in candidates),
            request.top_k,
            with_header,
        )
        cached = self._rerank_cache.get(key)
        if cached is not None:
            return cached
        documents = [_rerank_text(c, with_header=with_header) for c in candidates]
        try:
            items = self._reranker.rerank(request.query, documents, request.top_k)
        except RerankUnavailableError as exc:
            logger.warning("rerank unavailable, falling back to hybrid order: %s", exc)
            return None
        self._rerank_cache.set(key, items)
        return items


def _rerank_text(hit: SearchHit, *, with_header: bool) -> str:
    text = str(hit.metadata.get("text", ""))
    header = hit.metadata.get("context_header")
    return f"{header}\n\n{text}" if with_header and header else text


def _to_result(hit: SearchHit, rerank_score: float | None) -> RagSearchResult:
    m = hit.metadata
    return RagSearchResult(
        id=hit.id,
        text=str(m.get("text", "")),
        score=rerank_score if rerank_score is not None else hit.score,
        retrieval_score=hit.score,
        rerank_score=rerank_score,
        ticker=str(m.get("ticker", "")),
        company_name=str(m.get("company_name", "")),
        fiscal_year=int(m.get("fiscal_year", 0)),
        fiscal_quarter=int(m.get("fiscal_quarter", 0)),
        call_date=m.get("call_date") or None,
        speaker=str(m.get("speaker", "")),
        role=m.get("role") or None,
        section=m.get("section", "prepared_remarks"),
        chunk_index=int(m.get("chunk_index", 0)),
        context_header=str(m.get("context_header", "")),
    )
