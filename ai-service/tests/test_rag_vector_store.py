"""Tests for the Pinecone vector store wrapper (mocked SDK)."""

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

from pinecone import ServiceError

from app.models.transcript import SpeakerTurn, Transcript
from app.services.rag.chunking import chunk_transcript
from app.services.rag.embeddings import SparseVector
from app.services.rag.retry import RetryPolicy
from app.services.rag.vector_store import PineconeVectorStore

NO_SLEEP = RetryPolicy(max_attempts=3, base_delay=0, sleep=lambda _: None)


def make_store(pc: MagicMock, batch_size: int = 2) -> PineconeVectorStore:
    return PineconeVectorStore(
        pc,
        index_name="test-index",
        dimension=2,
        cloud="aws",
        region="us-east-1",
        upsert_batch_size=batch_size,
        retry_policy=NO_SLEEP,
    )


def sample_chunks(n: int):
    transcript = Transcript(
        ticker="MSFT",
        company_name="Microsoft Corp",
        call_date=date(2025, 7, 30),
        fiscal_year=2025,
        fiscal_quarter=4,
        turns=[
            SpeakerTurn(
                speaker_index=i,
                speaker_role="CFO",
                text=f"Azure revenue grew {i}0% year over year in constant currency.",
            )
            for i in range(n)
        ],
    )
    return chunk_transcript(transcript)


def test_ensure_index_creates_hybrid_index_once() -> None:
    pc = MagicMock()
    pc.has_index.return_value = False
    store = make_store(pc)

    store.ensure_index()

    kwargs = pc.create_index.call_args.kwargs
    assert kwargs["metric"] == "dotproduct"
    assert kwargs["vector_type"] == "dense"
    assert kwargs["dimension"] == 2

    pc.reset_mock()
    pc.has_index.return_value = True
    store.ensure_index()
    pc.create_index.assert_not_called()


def test_upsert_batches_with_stable_ids_and_retries() -> None:
    pc = MagicMock()
    index = pc.Index.return_value
    index.upsert.side_effect = [ServiceError("busy", 503), None, None]
    chunks = sample_chunks(3)
    sparse = [SparseVector([1], [0.3]), SparseVector([], []), SparseVector([2], [1])]

    count = make_store(pc).upsert_chunks(
        chunks, [[1.0, 0.0]] * 3, sparse, namespace="ns"
    )

    assert count == 3
    assert index.upsert.call_count == 3  # 1 retry + 2 batches
    first_batch = index.upsert.call_args_list[1].kwargs["vectors"]
    assert first_batch[0]["id"] == "MSFT#FY2025Q4#0000"
    assert first_batch[0]["sparse_values"] == {"indices": [1], "values": [0.3]}
    assert "sparse_values" not in first_batch[1]  # empty sparse vectors omitted
    assert first_batch[0]["metadata"]["fiscal_quarter"] == 4


def test_query_passes_filter_and_sparse_vector() -> None:
    pc = MagicMock()
    index = pc.Index.return_value
    index.query.return_value = SimpleNamespace(
        matches=[SimpleNamespace(id="a", score=0.8, metadata={"ticker": "MSFT"})]
    )

    hits = make_store(pc).query(
        dense=[1.0, 0.0],
        sparse=SparseVector([4], [0.5]),
        metadata_filter={"ticker": {"$eq": "MSFT"}},
        top_k=25,
        namespace="ns",
    )

    assert hits[0].id == "a" and hits[0].metadata["ticker"] == "MSFT"
    kwargs = index.query.call_args.kwargs
    assert kwargs["filter"] == {"ticker": {"$eq": "MSFT"}}
    assert kwargs["sparse_vector"] == {"indices": [4], "values": [0.5]}
    assert kwargs["top_k"] == 25


def test_delete_stale_removes_only_unknown_ids() -> None:
    pc = MagicMock()
    index = pc.Index.return_value
    index.list.return_value = iter(
        [
            SimpleNamespace(
                vectors=[SimpleNamespace(id="T#1"), SimpleNamespace(id="T#2")]
            ),
            SimpleNamespace(vectors=[SimpleNamespace(id="T#3")]),
        ]
    )

    deleted = make_store(pc).delete_stale("T#", {"T#1"}, namespace="ns")

    assert deleted == 2
    index.delete.assert_called_once_with(ids=["T#2", "T#3"], namespace="ns")
