"""Report eval: deterministic checks, estimate-only by default, and the run loop."""

import asyncio
from typing import Any

import pytest

from app.models.chat import Citation
from app.models.report import (
    SECTIONS,
    DataSource,
    ReportAsOf,
    ReportPeriod,
    ReportSection,
    ResearchReportContent,
)
from app.services.evals.judge import JudgedAnswer, JudgeVerdict
from app.services.evals.report_checks import figures, run_report_checks
from app.services.report.assemble import PRICE_UNAVAILABLE
from app.services.report.prompts import NO_COMPARISON
from app.services.report.service import ReportEvent
from scripts import eval_report

TEXT = {
    "summary": "Data center revenue rose to $96 billion in Q2 FY2027 [1].",
    "drivers": "- Demand: revenue of $96 billion, up 56% [1].",
    "guidance": "- Guided Q3 FY2027 revenue to $108 billion [1].",
    "changes": (
        "### Raised / improved\n"
        "- Guidance rose from $91 billion in Q1 FY2027 [2] to $108 billion [1].\n\n"
        "New, Lowered / worse, No longer mentioned, Unchanged: nothing found in "
        "the retrieved passages."
    ),
    "stock": "- Up 19.96% over 6 months, last close $181.50 on 2026-10-06 [D2].",
    "risks": "- Supply constraints persist in 2027 [1].",
}


def citation(i: int, quarter: int, text: str) -> Citation:
    return Citation(
        id=i,
        ticker="NVDA",
        company_name="Nvidia Corp",
        fiscal_year=2027,
        fiscal_quarter=quarter,
        call_date="2026-08-26",
        speaker="Colette Kress",
        section="prepared_remarks",
        text=text,
    )


def report(**sections: str) -> ResearchReportContent:
    text = {**TEXT, **sections}
    return ResearchReportContent(
        ticker="NVDA",
        company_name="Nvidia Corp",
        quarter=ReportPeriod(
            fiscal_year=2027, fiscal_quarter=2, call_date="2026-08-26"
        ),
        prior_quarter=ReportPeriod(fiscal_year=2027, fiscal_quarter=1),
        sections=[
            ReportSection(key=key, title=title, markdown=text[key])
            for key, title in SECTIONS
        ],
        citations=[
            citation(
                1,
                2,
                "Revenue was $96.0 billion, up 56%. We expect Q3 revenue of "
                "$108 billion. Supply remains constrained.",
            ),
            citation(2, 1, "We expect Q2 revenue of $91 billion, plus or minus 2%."),
        ],
        data_sources=[
            DataSource(
                id="D2",
                kind="price_history",
                ticker="NVDA",
                label="NVDA price history, 6mo",
                as_of="2026-10-06",
                data={"change_percent": 19.9632, "last_close": 181.5},
            )
        ],
        as_of=ReportAsOf(
            latest_call="2026-08-26",
            quote="2026-10-06 4:00 PM EDT",
            prices="2026-10-06",
        ),
    )


def failed(results) -> dict[str, str]:
    return {r.name: r.detail for r in results if not r.passed}


def test_a_good_report_passes_every_check() -> None:
    results = run_report_checks(report())

    assert failed(results) == {}
    assert [r.name for r in results] == [
        "sections_present",
        "citations_valid",
        "sections_cited",
        "numbers_from_sources",
        "changes_cite_both_quarters",
        "comparison_sections",
        "comparison_closing",
        "no_fundamentals",
        "disclaimer_and_dates",
    ]


def test_figures_skip_years_dates_labels_markers_and_small_counts() -> None:
    text = "In Q2 FY2027 [3] on 2026-08-26, 6 months, 2 quarters: $5, 8%, 1.5 and 40."

    assert figures(text) == [(5.0, 0), (8.0, 0), (1.5, 1), (40.0, 0)]


@pytest.mark.parametrize(
    ("sections", "check", "detail"),
    [
        ({"risks": ""}, "sections_present", "empty ['risks']"),
        ({"risks": "- Supply [9]."}, "citations_valid", "unknown passages [9]"),
        ({"stock": "- Up 19.96% [D7]."}, "citations_valid", "data ['D7']"),
        ({"risks": "- Supply persists."}, "sections_cited", "uncited ['risks']"),
        # A figure the market data doesn't have, and one the cited passage lacks.
        ({"stock": "- Up 35% [D2]."}, "numbers_from_sources", "stock: 35"),
        (
            {"drivers": "- Revenue of $54 billion [1]."},
            "numbers_from_sources",
            "drivers: 54",
        ),
        (
            {"changes": "### Raised / improved\n- Guidance rose [1]."},
            "changes_cite_both_quarters",
            "need [(2027, 1), (2027, 2)]",
        ),
        (
            {"stock": "- Trades at a P/E of 40 [D2]."},
            "no_fundamentals",
            "mentions ['P/E']",
        ),
    ],
)
def test_each_check_catches_its_failure(sections, check, detail) -> None:
    problems = failed(run_report_checks(report(**sections)))

    assert check in problems
    assert detail in problems[check]


def test_a_figure_from_another_sections_citation_doesnt_count() -> None:
    # $91 billion is only in passage [2]; the guidance section cites [1].
    problems = failed(
        run_report_checks(report(guidance="- Guided to $91 billion [1]."))
    )

    assert problems["numbers_from_sources"] == "not in sources: ['guidance: 91']"


def test_unavailable_sections_need_no_citations_or_comparison() -> None:
    content = report(stock=PRICE_UNAVAILABLE, changes=NO_COMPARISON).model_copy(
        update={
            "comparison_available": False,
            "market_data_available": False,
            "prior_quarter": None,
            "data_sources": [],
            "as_of": ReportAsOf(latest_call="2026-08-26"),
        }
    )

    results = run_report_checks(content)

    assert failed(results) == {}
    assert "changes_cite_both_quarters" not in [r.name for r in results]


def test_disclaimer_and_dates_are_required() -> None:
    content = report().model_copy(
        update={"disclaimer": "AI generated.", "as_of": ReportAsOf()}
    )

    detail = failed(run_report_checks(content))["disclaimer_and_dates"]

    assert detail == "missing ['disclaimer', 'latest call date', 'market data dates']"


def test_without_yes_it_prints_the_estimate_and_contacts_nothing(monkeypatch, capsys):
    def never(*_: Any, **__: Any):
        raise AssertionError("estimate mode must not build anything")

    monkeypatch.setattr(eval_report, "build_service", never)

    assert eval_report.main([]) == 0
    out = capsys.readouterr().out
    assert "Reports: 3 (NVDA, AAPL, MSFT), never saved" in out
    assert "judge gemini-3.1-pro-preview" in out
    assert "Total: ~$" in out and "Estimate only: nothing was contacted" in out


def test_the_eval_repository_never_stores_anything() -> None:
    repo = eval_report.EvalReportRepository()

    claim = repo.claim("NVDA", 2027, 2, regenerate_after=None, stale_after=None)
    assert claim.generation_id == "eval-NVDA-2027Q2"
    assert repo.save(claim.generation_id, content={}) is not None
    assert repo.release(claim.generation_id) is None


class FakeService:
    def __init__(self, outcomes: dict[str, Any]) -> None:
        self.outcomes = outcomes
        self.requests: list[Any] = []

    async def stream(self, request, *, trace_tags=()):
        self.requests.append((request, trace_tags))
        yield ReportEvent("agent", {"agent": "writer", "state": "running"})
        outcome = self.outcomes[request.ticker]
        if isinstance(outcome, str):
            yield ReportEvent("error", {"code": outcome, "message": "m"})
            return
        yield ReportEvent(
            "done",
            {
                "report": outcome.model_dump(mode="json"),
                "trace_id": "t1",
                "usage": {
                    "cost_usd": 0.05,
                    "input_tokens": 90_000,
                    "output_tokens": 6_000,
                },
            },
        )


async def fake_judge(prompt: str):
    assert "### Answer A" in prompt and "[2] NVDA Q1 FY2027" in prompt
    verdict = JudgeVerdict(
        answers=[
            JudgedAnswer(
                label="A", faithfulness=5, relevance=4, completeness=4, rationale="ok"
            )
        ],
        preferred="tie",
    )
    return verdict, (12_000, 1_500)


def test_evaluate_checks_and_judges_each_report() -> None:
    service = FakeService({"NVDA": report(), "AAPL": "research_failed"})

    results = asyncio.run(
        eval_report.evaluate(service, ["NVDA", "AAPL"], fake_judge, log=lambda _: None)
    )

    nvda, aapl = results
    assert nvda.passed and nvda.quarter == "Q2 FY2027"
    assert nvda.judge.faithfulness == 5 and nvda.judge_cost_usd > 0
    assert not aapl.passed and aapl.error == "research_failed: m"
    request, tags = service.requests[0]
    assert request.user_id == "system:eval" and request.regenerate_after_days == 0
    assert tags == ("eval",)
    table = eval_report.results_table(results)
    assert "| NVDA | Q2 FY2027 | 9/9 | — | 5 | 4 | 4 |" in table
    assert "research_failed: m" in table


def test_eval_settings_turn_off_ingestion_and_refresh() -> None:
    from app.config import Settings

    settings = eval_report.eval_report_settings(Settings(_env_file=None))

    assert settings.rag_daily_ingestion_cap == 0
    assert settings.rag_daily_refresh_cap == 0


# Regressions from the first real run (2026-10-07): both were check bugs.


def test_a_quote_time_is_not_a_figure() -> None:
    stock = (
        "- As of Oct 7, 2026, 3:54 PM EDT, NVDA was trading at $181.50, "
        "up 19.96% [D2]."
    )

    assert failed(run_report_checks(report(stock=stock))) == {}


def test_spoken_numbers_in_transcripts_count_as_sources() -> None:
    content = report(guidance="- The tax rate is expected around 16.5% [3].")
    spoken = citation(
        3,
        2,
        "our tax rate to be around 16 and a half percent finally today our board",
    )
    content = content.model_copy(update={"citations": [*content.citations, spoken]})

    assert failed(run_report_checks(content)) == {}
