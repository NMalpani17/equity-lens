"""Report request validation, content shape and settings."""

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.models.report import (
    SECTIONS,
    ReportDraft,
    ReportPeriod,
    ReportRequest,
    ReportSection,
    ResearchReportContent,
)


def test_request_normalizes_the_ticker_and_bounds_the_regenerate_window() -> None:
    request = ReportRequest(user_id="u1", ticker=" nvda ")

    assert request.ticker == "NVDA"
    assert request.regenerate_after_days == 7
    with pytest.raises(ValidationError):
        ReportRequest(user_id="u1", ticker="NOT A TICKER")
    with pytest.raises(ValidationError):
        ReportRequest(user_id="u1", ticker="NVDA", regenerate_after_days=-1)


def test_draft_fields_are_the_six_sections_in_order() -> None:
    assert tuple(ReportDraft.model_fields) == tuple(key for key, _ in SECTIONS)


def test_content_finds_sections_and_defaults_the_disclaimer() -> None:
    content = ResearchReportContent(
        ticker="NVDA",
        company_name="Nvidia Corp",
        quarter=ReportPeriod(fiscal_year=2027, fiscal_quarter=2),
        sections=[ReportSection(key="summary", title="Summary", markdown="x [1]")],
    )

    assert content.section("summary").markdown == "x [1]"
    assert content.section("risks") is None
    assert "not financial advice" in content.disclaimer
    assert content.model_dump(mode="json")["version"] == 1


def test_report_settings_need_chat_and_rag_settings() -> None:
    settings = Settings(_env_file=None)

    assert settings.report_research_model == "google_genai:gemini-3.5-flash-lite"
    assert settings.report_writer_model == "google_genai:gemini-3.8-flash"
    missing = settings.report_missing_settings
    assert "AI_SERVICE_GEMINI_API_KEY" in missing
    assert "DATABASE_URL" in missing
    assert len(missing) == len(set(missing))  # Gemini key listed once
