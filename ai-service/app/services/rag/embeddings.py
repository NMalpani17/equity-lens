"""Dense (Gemini) and sparse (Pinecone hosted) text encoders.

Both batch document calls, retry rate limits / transient errors with backoff,
and cache query encodings so repeated searches skip the network.
"""

import logging
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pinecone import Pinecone

from .cache import TTLCache
from .chunking import estimate_tokens
from .pinecone_errors import is_retryable_pinecone_error
from .rate_limit import SlidingWindowLimiter
from .retry import RetryPolicy, retry_call

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SparseVector:
    indices: list[int]
    values: list[float]

    def scaled(self, factor: float) -> "SparseVector":
        return SparseVector(self.indices, [v * factor for v in self.values])

    def to_pinecone(self) -> dict[str, list[Any]]:
        return {"indices": self.indices, "values": self.values}


class DenseEmbedder(Protocol):
    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class SparseEncoder(Protocol):
    def encode_documents(self, texts: Sequence[str]) -> list[SparseVector]: ...

    def encode_query(self, text: str) -> SparseVector: ...


def _batched[T](items: Sequence[T], size: int) -> list[Sequence[T]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def token_budget_batches(
    texts: Sequence[str], max_items: int, max_tokens: int
) -> list[Sequence[str]]:
    """Split texts into batches bounded by count and estimated tokens.

    ``max_tokens <= 0`` bounds by count only. A single text larger than the
    budget still gets its own batch.
    """
    batches: list[Sequence[str]] = []
    start, tokens = 0, 0
    for i, text in enumerate(texts):
        cost = estimate_tokens(text)
        too_many = i - start >= max_items
        too_big = max_tokens > 0 and tokens + cost > max_tokens and i > start
        if too_many or too_big:
            batches.append(texts[start:i])
            start, tokens = i, 0
        tokens += cost
    if start < len(texts):
        batches.append(texts[start:])
    return batches


def l2_normalize(values: Sequence[float]) -> list[float]:
    """Unit-normalize a vector (Gemini only normalizes full 3072-d output)."""
    norm = math.sqrt(sum(v * v for v in values))
    return [v / norm for v in values] if norm else list(values)


def is_retryable_gemini_error(exc: BaseException) -> bool:
    if isinstance(exc, genai_errors.APIError):
        return exc.code == 429 or exc.code >= 500
    return isinstance(exc, httpx.TransportError)


_RETRY_IN_RE = re.compile(r"retry in ([\d.]+)s", re.IGNORECASE)


def gemini_retry_after(exc: BaseException) -> float | None:
    """Server-requested delay from a Gemini 429 (RetryInfo or message text)."""
    if not isinstance(exc, genai_errors.APIError):
        return None
    error = (
        (exc.details or {}).get("error", {}) if isinstance(exc.details, dict) else {}
    )
    for detail in error.get("details", []) or []:
        delay = detail.get("retryDelay") if isinstance(detail, dict) else None
        if isinstance(delay, str) and delay.endswith("s"):
            try:
                return float(delay[:-1])
            except ValueError:
                pass
    match = _RETRY_IN_RE.search(str(exc))
    return float(match.group(1)) if match else None


class GeminiEmbedder:
    """Gemini embeddings with retrieval task types and fixed dimensionality."""

    def __init__(
        self,
        client: genai.Client,
        *,
        model: str,
        dimension: int,
        batch_size: int,
        retry_policy: RetryPolicy,
        query_cache: TTLCache[list[float]],
        limiter: SlidingWindowLimiter | None = None,
        token_limiter: SlidingWindowLimiter | None = None,
        max_batch_tokens: int = 0,
    ) -> None:
        self._client = client
        # Gemini counts every text in a batch toward its per-minute request
        # quota, and the batch's tokens toward its per-minute token quota. A
        # batch bigger than the token quota can never succeed, so batches are
        # also capped by estimated tokens.
        self._limiter = limiter or SlidingWindowLimiter(0)
        self._token_limiter = token_limiter or SlidingWindowLimiter(0)
        self._max_batch_tokens = max_batch_tokens
        self._model = model
        self._dimension = dimension
        self._batch_size = batch_size
        self._retry_policy = retry_policy
        self._query_cache = query_cache

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for batch in token_budget_batches(
            texts, self._batch_size, self._max_batch_tokens
        ):
            vectors.extend(self._embed(batch, "RETRIEVAL_DOCUMENT"))
        return vectors

    def embed_query(self, text: str) -> list[float]:
        key = ("dense", self._model, self._dimension, text)
        return self._query_cache.get_or_compute(
            key, lambda: self._embed([text], "RETRIEVAL_QUERY")[0]
        )

    def _embed(self, texts: Sequence[str], task_type: str) -> list[list[float]]:
        config = genai_types.EmbedContentConfig(
            task_type=task_type, output_dimensionality=self._dimension
        )

        def call() -> list[list[float]]:
            self._limiter.acquire(len(texts))
            self._token_limiter.acquire(sum(estimate_tokens(t) for t in texts))
            result = self._client.models.embed_content(
                model=self._model, contents=list(texts), config=config
            )
            embeddings = result.embeddings or []
            if len(embeddings) != len(texts):
                raise ValueError(
                    f"gemini returned {len(embeddings)} embeddings for "
                    f"{len(texts)} inputs"
                )
            return [l2_normalize(e.values or []) for e in embeddings]

        return retry_call(
            call,
            is_retryable=is_retryable_gemini_error,
            policy=self._retry_policy,
            operation=f"gemini embed ({len(texts)} texts)",
            retry_after=gemini_retry_after,
        )


class PineconeSparseEncoder:
    """Sparse lexical vectors from Pinecone's hosted ``pinecone-sparse-english-v0``."""

    def __init__(
        self,
        pc: Pinecone,
        *,
        model: str,
        batch_size: int,
        retry_policy: RetryPolicy,
        query_cache: TTLCache[SparseVector],
    ) -> None:
        self._pc = pc
        self._model = model
        self._batch_size = batch_size
        self._retry_policy = retry_policy
        self._query_cache = query_cache

    def encode_documents(self, texts: Sequence[str]) -> list[SparseVector]:
        vectors: list[SparseVector] = []
        for batch in _batched(texts, self._batch_size):
            vectors.extend(self._encode(batch, "passage"))
        return vectors

    def encode_query(self, text: str) -> SparseVector:
        key = ("sparse", self._model, text)
        return self._query_cache.get_or_compute(
            key, lambda: self._encode([text], "query")[0]
        )

    def _encode(self, texts: Sequence[str], input_type: str) -> list[SparseVector]:
        def call() -> list[SparseVector]:
            result = self._pc.inference.embed(
                model=self._model,
                inputs=list(texts),
                parameters={
                    "input_type": input_type,
                    "truncate": "END",
                    "max_tokens_per_sequence": 512,
                },
            )
            return [
                SparseVector(list(e.sparse_indices), list(e.sparse_values))
                for e in result.data
            ]

        return retry_call(
            call,
            is_retryable=is_retryable_pinecone_error,
            policy=self._retry_policy,
            operation=f"pinecone sparse embed ({len(texts)} texts)",
        )
