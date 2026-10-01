"""Wires RAG components together from settings (one instance per process)."""

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from functools import lru_cache

from google import genai
from pinecone import Pinecone
from psycopg_pool import ConnectionPool

from app.config import Settings, get_settings

from .cache import TTLCache
from .embeddings import GeminiEmbedder, PineconeSparseEncoder
from .equibles import EquiblesClient
from .errors import RagNotConfiguredError
from .ingestion import IngestionPipeline, TranscriptSource
from .jobs import IngestionCoordinator
from .repository import RagRepository, create_pool
from .reranker import PineconeReranker
from .retry import RetryPolicy
from .search import RagSearchService
from .vector_store import PineconeVectorStore

logger = logging.getLogger(__name__)

# Reranking is best-effort (search falls back to hybrid order), so don't spend
# long retrying it.
_RERANK_ATTEMPTS = 2


@dataclass(frozen=True)
class RagComponents:
    pool: ConnectionPool
    executor: ThreadPoolExecutor
    repo: RagRepository
    store: PineconeVectorStore
    pipeline: IngestionPipeline
    coordinator: IngestionCoordinator
    search: RagSearchService

    def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.pool.close()


def build_components(settings: Settings) -> RagComponents:
    missing = settings.rag_missing_settings
    if missing:
        raise RagNotConfiguredError(missing)

    retry = RetryPolicy(
        max_attempts=settings.rag_max_retries,
        base_delay=settings.rag_retry_base_seconds,
        max_delay=settings.rag_retry_max_seconds,
    )
    pc = Pinecone(api_key=settings.pinecone_api_key)
    pool = create_pool(settings.database_url, settings.db_pool_max_size)
    repo = RagRepository(pool)

    embedder = GeminiEmbedder(
        genai.Client(api_key=settings.gemini_api_key),
        model=settings.gemini_embedding_model,
        dimension=settings.embedding_dimension,
        batch_size=settings.embedding_batch_size,
        retry_policy=retry,
        query_cache=TTLCache(
            settings.rag_query_cache_size, settings.rag_query_cache_ttl_seconds
        ),
    )
    sparse = PineconeSparseEncoder(
        pc,
        model=settings.pinecone_sparse_model,
        batch_size=settings.sparse_batch_size,
        retry_policy=retry,
        query_cache=TTLCache(
            settings.rag_query_cache_size, settings.rag_query_cache_ttl_seconds
        ),
    )
    store = PineconeVectorStore(
        pc,
        index_name=settings.pinecone_index_name,
        dimension=settings.embedding_dimension,
        cloud=settings.pinecone_cloud,
        region=settings.pinecone_region,
        upsert_batch_size=settings.upsert_batch_size,
        retry_policy=retry,
    )
    source = TranscriptSource(
        EquiblesClient(
            settings.equibles_api_key,
            base_url=settings.equibles_base_url,
            timeout=settings.equibles_timeout_seconds,
            retry_policy=retry,
        ),
        repo,
        quarters=settings.rag_quarters,
    )
    pipeline = IngestionPipeline(
        source,
        embedder,
        sparse,
        store,
        namespace=settings.pinecone_namespace,
        plain_namespace=settings.pinecone_plain_namespace,
        chunk_tokens=settings.rag_chunk_tokens,
        overlap_tokens=settings.rag_chunk_overlap_tokens,
    )
    executor = ThreadPoolExecutor(
        max_workers=settings.rag_ingestion_workers, thread_name_prefix="rag-ingest"
    )
    coordinator = IngestionCoordinator(
        repo,
        pipeline,
        executor,
        daily_cap=settings.rag_daily_ingestion_cap,
        stale_after=timedelta(minutes=settings.rag_stale_job_minutes),
    )
    search = RagSearchService(
        repo,
        coordinator,
        embedder,
        sparse,
        store,
        PineconeReranker(
            pc,
            model=settings.pinecone_rerank_model,
            retry_policy=RetryPolicy(
                max_attempts=_RERANK_ATTEMPTS,
                base_delay=settings.rag_retry_base_seconds,
                max_delay=settings.rag_retry_max_seconds,
            ),
        ),
        rerank_cache=TTLCache(
            settings.rag_query_cache_size, settings.rag_query_cache_ttl_seconds
        ),
        namespace=settings.pinecone_namespace,
        candidate_k=settings.rag_candidate_k,
        alpha=settings.rag_hybrid_alpha,
    )
    return RagComponents(pool, executor, repo, store, pipeline, coordinator, search)


@lru_cache
def get_rag_components() -> RagComponents:
    """Process-wide RAG components, built on first use."""
    return build_components(get_settings())


def shutdown_rag_components() -> None:
    """Close the pool and executor if they were ever built."""
    if get_rag_components.cache_info().currsize:
        get_rag_components().close()
        get_rag_components.cache_clear()
