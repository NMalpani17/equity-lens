"""Pinecone serverless index: creation, idempotent upserts, hybrid queries.

A single index holds dense + sparse values per record. Pinecone requires
``metric="dotproduct"`` for that, which is fine because the dense vectors are
unit-normalized (dot product == cosine similarity).
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pinecone import Pinecone, ServerlessSpec

from .chunking import Chunk
from .embeddings import SparseVector
from .pinecone_errors import is_retryable_pinecone_error
from .retry import RetryPolicy, retry_call

logger = logging.getLogger(__name__)

_DELETE_BATCH = 1000
_INDEX_READY_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class SearchHit:
    """One candidate returned by the vector index."""

    id: str
    score: float
    metadata: dict[str, Any]


class PineconeVectorStore:
    def __init__(
        self,
        pc: Pinecone,
        *,
        index_name: str,
        dimension: int,
        cloud: str,
        region: str,
        upsert_batch_size: int,
        retry_policy: RetryPolicy,
    ) -> None:
        self._pc = pc
        self._index_name = index_name
        self._dimension = dimension
        self._cloud = cloud
        self._region = region
        self._upsert_batch_size = upsert_batch_size
        self._retry_policy = retry_policy
        self._index: Any = None
        self._index_ready = False

    def ensure_index(self) -> None:
        """Create the hybrid-capable index if it does not exist (idempotent)."""
        if self._index_ready:
            return
        if self._pc.has_index(self._index_name):
            self._index_ready = True
            return
        logger.info(
            "creating pinecone index %s (dim=%d, dotproduct, %s/%s)",
            self._index_name,
            self._dimension,
            self._cloud,
            self._region,
        )
        self._pc.create_index(
            name=self._index_name,
            vector_type="dense",
            dimension=self._dimension,
            metric="dotproduct",
            spec=ServerlessSpec(cloud=self._cloud, region=self._region),
            timeout=_INDEX_READY_TIMEOUT_SECONDS,
        )
        self._index_ready = True

    @property
    def index(self) -> Any:
        if self._index is None:
            self._index = self._pc.Index(name=self._index_name)
        return self._index

    def upsert_chunks(
        self,
        chunks: Sequence[Chunk],
        dense: Sequence[list[float]],
        sparse: Sequence[SparseVector] | None,
        *,
        namespace: str,
    ) -> int:
        """Upsert chunks in batches under their stable IDs. Returns the count."""
        records = []
        for i, chunk in enumerate(chunks):
            record: dict[str, Any] = {
                "id": chunk.id,
                "values": dense[i],
                "metadata": chunk.metadata(),
            }
            if sparse is not None and sparse[i].indices:
                record["sparse_values"] = sparse[i].to_pinecone()
            records.append(record)

        for start in range(0, len(records), self._upsert_batch_size):
            batch = records[start : start + self._upsert_batch_size]
            self._call(
                lambda b=batch: self.index.upsert(vectors=b, namespace=namespace),
                f"pinecone upsert ({len(batch)} records)",
            )
        return len(records)

    def delete_stale(self, prefix: str, keep_ids: set[str], *, namespace: str) -> int:
        """Delete IDs under ``prefix`` that are not in ``keep_ids``."""
        stale: list[str] = []
        for page in self.index.list(prefix=prefix, namespace=namespace):
            stale.extend(
                item.id
                for item in page.vectors
                if item.id is not None and item.id not in keep_ids
            )
        for start in range(0, len(stale), _DELETE_BATCH):
            batch = stale[start : start + _DELETE_BATCH]
            self._call(
                lambda b=batch: self.index.delete(ids=b, namespace=namespace),
                f"pinecone delete ({len(batch)} ids)",
            )
        if stale:
            logger.info("deleted %d stale vectors under %s", len(stale), prefix)
        return len(stale)

    def delete_prefix(self, prefix: str, *, namespace: str) -> int:
        """Delete every ID under ``prefix`` (e.g. one quarter of a ticker)."""
        return self.delete_stale(prefix, set(), namespace=namespace)

    def query(
        self,
        *,
        dense: list[float],
        sparse: SparseVector | None,
        metadata_filter: dict[str, Any] | None,
        top_k: int,
        namespace: str,
    ) -> list[SearchHit]:
        """Query with the filter applied inside Pinecone (pre-filtering)."""
        kwargs: dict[str, Any] = {
            "vector": dense,
            "top_k": top_k,
            "namespace": namespace,
            "include_metadata": True,
        }
        if sparse is not None and sparse.indices:
            kwargs["sparse_vector"] = sparse.to_pinecone()
        if metadata_filter:
            kwargs["filter"] = metadata_filter
        response = self._call(lambda: self.index.query(**kwargs), "pinecone query")
        return [
            SearchHit(id=m.id, score=float(m.score), metadata=dict(m.metadata or {}))
            for m in response.matches
        ]

    def _call(self, fn: Any, operation: str) -> Any:
        return retry_call(
            fn,
            is_retryable=is_retryable_pinecone_error,
            policy=self._retry_policy,
            operation=operation,
        )
