"""The pre-generate script: estimate-only by default, budgeted, honest exit code."""

import re
from pathlib import Path
from typing import Any

import pytest

from app.config import Settings
from app.services.evals.pricing import estimate_reports
from app.services.report.service import ReportEvent
from scripts import pregenerate_reports as script

REPO = Path(__file__).resolve().parents[2]


def settings() -> Settings:
    return Settings(_env_file=None)


class FakeService:
    """Replays a scripted outcome per ticker and records the requests."""

    def __init__(self, outcomes: dict[str, Any]) -> None:
        self.outcomes = outcomes
        self.requests: list[tuple[Any, tuple[str, ...]]] = []

    async def stream(self, request, *, trace_tags=()):
        self.requests.append((request, trace_tags))
        yield ReportEvent(
            "agent",
            {"agent": "transcripts", "state": "running", "label": "Researching…"},
        )
        outcome = self.outcomes[request.ticker]
        if isinstance(outcome, str):
            yield ReportEvent(
                "error", {"code": outcome, "message": "m", "retryable": False}
            )
            return
        yield ReportEvent(
            "done",
            {
                "fiscal_year": 2027,
                "fiscal_quarter": 2,
                "usage": {
                    "cost_usd": outcome,
                    "input_tokens": 90_000,
                    "output_tokens": 6_000,
                },
            },
        )


def never_built() -> Any:
    raise AssertionError("estimate mode must not build the service")


def test_without_yes_it_only_prints_the_estimate(capsys) -> None:
    code = script.main([], settings=settings(), service_factory=never_built)

    out = capsys.readouterr().out
    expected = estimate_reports(settings(), 4)
    assert code == 0
    assert "Reports: 4 (AAPL, MSFT, NVDA, TSLA)" in out
    assert f"~${expected.typical_total:.2f} typical" in out
    assert f"${expected.most_total:.2f} at most" in out
    assert "Pinecone reranks: at most 24" in out
    assert "Estimate only: nothing was contacted" in out


def test_report_estimate_matches_the_documented_prices() -> None:
    estimate = estimate_reports(settings(), 4)

    # Flash-Lite $0.30/$2.50, Flash $0.75/$3.75 per 1M tokens.
    assert estimate.models == {
        "transcripts": "gemini-3.8-flash",
        "market": "gemini-3.5-flash-lite",
        "writer": "gemini-3.8-flash",
    }
    assert estimate.typical_usd["transcripts"] == pytest.approx(
        (45_000 * 0.75 + 3_500 * 3.75) / 1e6
    )
    assert estimate.typical_usd["writer"] == pytest.approx(
        (15_000 * 0.75 + 3_000 * 3.75) / 1e6
    )
    assert estimate.typical_total == pytest.approx(0.2907, abs=1e-4)
    # At most: the researcher's corrective turn reruns its agent (2 x 5 calls
    # of 22K in / 4,096 out), the market analyst 3 calls of 8K / 2,048, and
    # the writer writes twice (16K / 8,192 each).
    assert estimate.most_usd["transcripts"] == pytest.approx(
        (10 * 22_000 * 0.75 + 10 * 4_096 * 3.75) / 1e6
    )
    assert estimate.most_usd["writer"] == pytest.approx(
        (2 * 16_000 * 0.75 + 2 * 8_192 * 3.75) / 1e6
    )
    assert estimate.most_total == pytest.approx(1.7064, abs=1e-4)
    # Two comparison reranks plus 2 searches in each of the researcher's runs.
    assert estimate.reranks_max == 4 * (2 + 2 * 2)


def test_yes_generates_each_ticker_and_reports_actual_spend(capsys) -> None:
    service = FakeService({"AAPL": 0.05, "MSFT": "report_fresh", "NVDA": 0.06})

    code = script.main(
        ["--yes", "--tickers", "aapl", "MSFT", "NVDA", "AAPL"],
        settings=settings(),
        service_factory=lambda: service,
    )

    out = capsys.readouterr().out
    assert code == 0  # a fresh report is skipped, not a failure
    tickers = [r.ticker for r, _ in service.requests]
    assert tickers == ["AAPL", "MSFT", "NVDA"]  # normalized, de-duplicated
    request, tags = service.requests[0]
    assert request.user_id == "system:pregenerate" and tags == ("pregenerate",)
    assert request.regenerate_after_days == 7
    assert "MSFT: skipped report_fresh" in out
    assert "Actual spend: $0.1100" in out


def test_force_regenerates_fresh_reports() -> None:
    service = FakeService({"NVDA": 0.05})

    script.main(
        ["--yes", "--force", "--tickers", "NVDA"],
        settings=settings(),
        service_factory=lambda: service,
    )

    assert service.requests[0][0].regenerate_after_days == 0


def test_the_budget_stops_before_the_next_report(capsys) -> None:
    service = FakeService({"AAPL": 0.30, "MSFT": 0.30, "NVDA": 0.30})

    code = script.main(
        ["--yes", "--max-cost", "0.5", "--tickers", "AAPL", "MSFT", "NVDA"],
        settings=settings(),
        service_factory=lambda: service,
    )

    assert [r.ticker for r, _ in service.requests] == ["AAPL", "MSFT"]
    assert "budget $0.50 reached" in capsys.readouterr().out
    assert code == 1  # NVDA didn't run


def test_a_failed_report_fails_the_run(capsys) -> None:
    service = FakeService({"NVDA": "research_failed"})

    code = script.main(
        ["--yes", "--tickers", "NVDA"],
        settings=settings(),
        service_factory=lambda: service,
    )

    assert code == 1
    assert "NVDA: failed research_failed: m" in capsys.readouterr().out


def test_demo_tickers_match_the_demo_portfolio_minus_etfs() -> None:
    source = (REPO / "api/src/services/demoHoldings.ts").read_text(encoding="utf-8")
    demo = set(re.findall(r'ticker: "([A-Z.]+)"', source))

    assert set(script.DEMO_TICKERS) == demo - {"VOO"}


def test_exit_waits_for_the_trace_upload_before_closing_rag(monkeypatch) -> None:
    from app.services.observability import tracing
    from app.services.rag import container

    calls: list[tuple[str, float | None]] = []
    monkeypatch.setattr(
        tracing,
        "shutdown_tracer",
        lambda timeout=3.0: calls.append(("tracer", timeout)),
    )
    monkeypatch.setattr(
        container, "shutdown_rag_components", lambda: calls.append(("rag", None))
    )

    script.shutdown()

    assert calls == [("tracer", tracing.SCRIPT_SHUTDOWN_TIMEOUT_SECONDS), ("rag", None)]
    assert tracing.SCRIPT_SHUTDOWN_TIMEOUT_SECONDS == 30.0
