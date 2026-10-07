"""The report's models, built from settings ("provider:model", swappable)."""

from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import Runnable

from app.config import Settings
from app.models.report import ReportDraft


def _model(settings: Settings, spec: str, max_tokens: int) -> BaseChatModel:
    kwargs: dict[str, Any] = {
        "max_tokens": max_tokens,
        "timeout": settings.report_model_timeout_seconds,
        "max_retries": 2,
    }
    if spec.startswith("google_genai:"):
        kwargs["api_key"] = settings.gemini_api_key
        kwargs["thinking_level"] = settings.report_thinking_level
    return init_chat_model(spec, **kwargs)


def build_research_model(settings: Settings) -> BaseChatModel:
    """Flash-Lite by default: both researchers' tool-calling agents."""
    return _model(
        settings,
        settings.report_research_model,
        settings.report_research_max_output_tokens,
    )


def build_writer(settings: Settings) -> Runnable:
    """The writer: structured output, with the raw message kept for usage."""
    model = _model(
        settings, settings.report_writer_model, settings.report_writer_max_output_tokens
    )
    return model.with_structured_output(ReportDraft, include_raw=True)
