"""Tests for the seed CLI using fake components."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services.rag.ingestion import IngestionResult
from app.services.rag.jobs import JobOutcome
from scripts import seed_transcripts
from tests.rag_fakes import FakeRepo


def fake_components(outcomes: dict[str, JobOutcome]) -> SimpleNamespace:
    coordinator = MagicMock()
    coordinator.run_job.side_effect = lambda job_id, ticker, **_: outcomes[ticker]
    return SimpleNamespace(
        repo=FakeRepo(), store=MagicMock(), coordinator=coordinator, close=MagicMock()
    )


def ok(ticker: str) -> JobOutcome:
    return JobOutcome(True, IngestionResult(ticker, ticker, ["FY2025Q4"], 10))


def test_seed_skips_indexed_and_stops_when_quota_runs_out(monkeypatch, capsys) -> None:
    rag = fake_components(
        {
            "AAPL": ok("AAPL"),
            "MSFT": JobOutcome(False, error="quota", quota_exhausted=True),
            "NVDA": ok("NVDA"),
        }
    )
    rag.repo.claim_ingestion("AAPL", trigger="seed", daily_cap=None, stale_after=None)
    rag.repo.complete_job(
        rag.repo.tickers["AAPL"].last_job_id,
        "AAPL",
        company_name="Apple",
        chunk_count=1,
        quarters=[],
    )
    monkeypatch.setattr(seed_transcripts, "build_components", lambda _: rag)

    code = seed_transcripts.main(["AAPL", "MSFT", "NVDA"])

    out = capsys.readouterr().out
    assert code == 1
    assert "AAPL   skipped (already_indexed)" in out
    assert "MSFT   failed: quota" in out
    assert "NVDA" not in out  # stopped after the quota error
    rag.store.ensure_index.assert_called_once()
    rag.close.assert_called_once()
