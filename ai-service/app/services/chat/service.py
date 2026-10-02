"""Builds the process-wide chat service from settings."""

from functools import lru_cache
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from app.config import Settings, get_settings
from app.errors import AppError

from .agent import ChatService
from .context import turn_registry
from .mcp_server import mcp


def build_chat_model(settings: Settings) -> BaseChatModel:
    """The configured chat model ("provider:model"), provider-agnostic."""
    kwargs: dict[str, Any] = {
        "max_tokens": settings.chat_max_output_tokens,
        "timeout": settings.chat_timeout_seconds,
        "max_retries": 2,
    }
    if settings.chat_model.startswith("google_genai:"):
        kwargs["api_key"] = settings.gemini_api_key
        kwargs["thinking_level"] = settings.chat_thinking_level
    return init_chat_model(settings.chat_model, **kwargs)


@lru_cache
def get_chat_service() -> ChatService:
    settings = get_settings()
    missing = settings.chat_missing_settings
    if missing:
        raise AppError(
            503, "chat_not_configured", "chat is not configured", {"missing": missing}
        )
    return ChatService(settings, lambda: build_chat_model(settings), mcp, turn_registry)
