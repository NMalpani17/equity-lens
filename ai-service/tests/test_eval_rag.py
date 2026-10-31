"""The eval namespace build is recorded as an ingestion job."""

from types import SimpleNamespace

import pytest

from scripts.eval_rag import PLAIN_TRIGGER, build_plain


class FakeRepo:
    def __init__(self) -> None:
        self.events: list[tuple] = []

    def start_detached_job(self, ticker: str, *, trigger: str) -> str:
        self.events.append(("start", ticker, trigger))
        return "job-1"

    def finish_detached_job(
        self, job_id: str, *, chunk_count: int = 0, error: str | None = None
    ) -> None:
        self.events.append(("finish", job_id, chunk_count, error))


class FakePipeline:
    def __init__(self, repo: FakeRepo, error: Exception | None = None) -> None:
        self.repo = repo
        self.error = error

    def ingest(self, ticker: str, **kwargs) -> SimpleNamespace:
        self.repo.events.append(("ingest", ticker, kwargs))
        if self.error:
            raise self.error
        return SimpleNamespace(chunk_count=42)


def test_build_plain_wraps_the_write_in_a_job() -> None:
    repo = FakeRepo()

    build_plain(repo, FakePipeline(repo), "NVDA")

    assert repo.events == [
        ("start", "NVDA", PLAIN_TRIGGER),
        ("ingest", "NVDA", {"cache_only": True, "plain_only": True}),
        ("finish", "job-1", 42, None),
    ]


def test_build_plain_closes_the_job_when_ingestion_fails() -> None:
    repo = FakeRepo()

    with pytest.raises(RuntimeError):
        build_plain(repo, FakePipeline(repo, RuntimeError("pinecone down")), "NVDA")

    assert repo.events[-1] == ("finish", "job-1", 0, "pinecone down")
