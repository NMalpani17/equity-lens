"""Tests for the dense/sparse encoders, cache, and reranker (mocked SDKs)."""

import math
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from google.genai import errors as genai_errors
from pinecone import ApiError, RateLimitError

from app.services.rag.cache import TTLCache
from app.services.rag.embeddings import (
    GeminiEmbedder,
    PineconeSparseEncoder,
    SparseVector,
    l2_normalize,
)
from app.services.rag.errors import RerankUnavailableError
from app.services.rag.reranker import PineconeReranker
from app.services.rag.retry import RetryPolicy

NO_SLEEP = RetryPolicy(max_attempts=3, base_delay=0, sleep=lambda _: None)


def gemini_response(n: int) -> SimpleNamespace:
    return SimpleNamespace(
        embeddings=[SimpleNamespace(values=[3.0, 4.0]) for _ in range(n)]
    )


def make_gemini(client: MagicMock, batch_size: int = 2) -> GeminiEmbedder:
    return GeminiEmbedder(
        client,
        model="gemini-embedding-001",
        dimension=2,
        batch_size=batch_size,
        retry_policy=NO_SLEEP,
        query_cache=TTLCache(10, 60),
    )


def test_l2_normalize() -> None:
    assert l2_normalize([3.0, 4.0]) == [0.6, 0.8]
    assert l2_normalize([0.0, 0.0]) == [0.0, 0.0]


def test_gemini_batches_documents_and_normalizes() -> None:
    client = MagicMock()
    client.models.embed_content.side_effect = lambda **kw: gemini_response(
        len(kw["contents"])
    )

    vectors = make_gemini(client, batch_size=2).embed_documents(["a", "b", "c"])

    assert len(vectors) == 3
    assert client.models.embed_content.call_count == 2
    assert math.isclose(sum(v * v for v in vectors[0]), 1.0)
    config = client.models.embed_content.call_args.kwargs["config"]
    assert config.task_type == "RETRIEVAL_DOCUMENT"
    assert config.output_dimensionality == 2


def test_gemini_query_embeddings_are_cached() -> None:
    client = MagicMock()
    client.models.embed_content.return_value = gemini_response(1)
    embedder = make_gemini(client)

    first = embedder.embed_query("What drove margins?")
    second = embedder.embed_query("What drove margins?")

    assert first == second
    assert client.models.embed_content.call_count == 1
    config = client.models.embed_content.call_args.kwargs["config"]
    assert config.task_type == "RETRIEVAL_QUERY"


def test_gemini_retries_rate_limits() -> None:
    client = MagicMock()
    client.models.embed_content.side_effect = [
        genai_errors.ClientError(429, {"error": {"message": "slow down"}}),
        gemini_response(1),
    ]

    assert len(make_gemini(client).embed_documents(["a"])) == 1
    assert client.models.embed_content.call_count == 2


def test_gemini_does_not_retry_bad_requests() -> None:
    client = MagicMock()
    client.models.embed_content.side_effect = genai_errors.ClientError(
        400, {"error": {"message": "bad"}}
    )

    with pytest.raises(genai_errors.ClientError):
        make_gemini(client).embed_documents(["a"])
    assert client.models.embed_content.call_count == 1


def test_sparse_encoder_batches_and_caches_queries() -> None:
    pc = MagicMock()
    pc.inference.embed.side_effect = lambda **kw: SimpleNamespace(
        data=[
            SimpleNamespace(sparse_indices=[1, 7], sparse_values=[0.5, 0.2])
            for _ in kw["inputs"]
        ]
    )
    encoder = PineconeSparseEncoder(
        pc,
        model="pinecone-sparse-english-v0",
        batch_size=2,
        retry_policy=NO_SLEEP,
        query_cache=TTLCache(10, 60),
    )

    docs = encoder.encode_documents(["a", "b", "c"])
    encoder.encode_query("EBITDA")
    encoder.encode_query("EBITDA")

    assert docs[0] == SparseVector([1, 7], [0.5, 0.2])
    assert pc.inference.embed.call_count == 3  # two doc batches + one query
    assert pc.inference.embed.call_args.kwargs["parameters"]["input_type"] == "query"


def test_ttl_cache_expires_and_evicts_lru() -> None:
    now = [0.0]
    cache: TTLCache[int] = TTLCache(max_size=2, ttl_seconds=10, clock=lambda: now[0])
    cache.set("a", 1)
    cache.set("b", 2)
    cache.get("a")  # "a" is now most recently used
    cache.set("c", 3)  # evicts "b"

    assert cache.get("b") is None
    assert cache.get("a") == 1
    now[0] = 11
    assert cache.get("a") is None


def test_reranker_returns_ordered_items() -> None:
    pc = MagicMock()
    pc.inference.rerank.return_value = SimpleNamespace(
        data=[SimpleNamespace(index=2, score=0.9), SimpleNamespace(index=0, score=0.4)]
    )
    reranker = PineconeReranker(pc, model="bge-reranker-v2-m3", retry_policy=NO_SLEEP)

    items = reranker.rerank("q", ["d0", "d1", "d2"], top_n=2)

    assert [(i.index, i.score) for i in items] == [(2, 0.9), (0, 0.4)]
    assert pc.inference.rerank.call_args.kwargs["top_n"] == 2


def test_reranker_wraps_failures_for_fallback() -> None:
    pc = MagicMock()
    pc.inference.rerank.side_effect = RateLimitError("monthly quota", 429)
    reranker = PineconeReranker(pc, model="bge-reranker-v2-m3", retry_policy=NO_SLEEP)

    with pytest.raises(RerankUnavailableError):
        reranker.rerank("q", ["d0"], top_n=1)


def test_reranker_does_not_retry_client_errors() -> None:
    pc = MagicMock()
    pc.inference.rerank.side_effect = ApiError("bad", 400)
    reranker = PineconeReranker(pc, model="bge-reranker-v2-m3", retry_policy=NO_SLEEP)

    with pytest.raises(RerankUnavailableError):
        reranker.rerank("q", ["d0"], top_n=1)
    assert pc.inference.rerank.call_count == 1


def test_token_budget_batches_respect_count_and_tokens() -> None:
    from app.services.rag.embeddings import token_budget_batches

    texts = ["x" * 400] * 5  # ~100 tokens each

    assert [len(b) for b in token_budget_batches(texts, 10, 250)] == [2, 2, 1]
    assert [len(b) for b in token_budget_batches(texts, 3, 0)] == [3, 2]
    assert [len(b) for b in token_budget_batches(["x" * 4000], 10, 250)] == [1]


def test_gemini_splits_batches_that_exceed_the_token_budget() -> None:
    client = MagicMock()
    client.models.embed_content.side_effect = lambda **kw: gemini_response(
        len(kw["contents"])
    )
    embedder = GeminiEmbedder(
        client,
        model="gemini-embedding-001",
        dimension=2,
        batch_size=100,
        retry_policy=NO_SLEEP,
        query_cache=TTLCache(10, 60),
        max_batch_tokens=250,
    )

    embedder.embed_documents(["x" * 400] * 5)

    sizes = [
        len(c.kwargs["contents"]) for c in client.models.embed_content.call_args_list
    ]
    assert sizes == [2, 2, 1]


def daily_quota_error() -> genai_errors.ClientError:
    return genai_errors.ClientError(
        429,
        {
            "error": {
                "code": 429,
                "message": "Quota exceeded. Please retry in 32s.",
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        "violations": [
                            {
                                "quotaId": "EmbedContentRequestsPerDayPerUserPer"
                                "ProjectPerModel-FreeTier",
                                "quotaValue": "1000",
                            }
                        ],
                    },
                    {
                        "@type": "type.googleapis.com/google.rpc.RetryInfo",
                        "retryDelay": "32s",
                    },
                ],
            }
        },
    )


def test_daily_quota_fails_fast_without_retrying() -> None:
    from app.services.rag.errors import EmbeddingQuotaExhaustedError

    client = MagicMock()
    client.models.embed_content.side_effect = daily_quota_error()

    with pytest.raises(EmbeddingQuotaExhaustedError):
        make_gemini(client).embed_documents(["a"])
    assert client.models.embed_content.call_count == 1
