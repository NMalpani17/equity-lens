"""Map model/provider failures to stable, user-safe chat error codes.

Gemini prepaid credit exhaustion is HTTP 402 (don't retry), rate limits are
429, and disabled billing is a 400 failed_precondition. LangChain wraps the
SDK error, so the HTTP status is read from the exception chain.
"""

from dataclasses import dataclass

from langchain_core.exceptions import ModelRateLimitError, ModelTimeoutError


@dataclass(frozen=True)
class ChatError:
    code: str
    message: str
    retryable: bool
    expected: bool = True


def _status_code(exc: BaseException) -> int | None:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        for attr in ("code", "status_code", "status"):
            value = getattr(current, attr, None)
            if isinstance(value, int) and 100 <= value < 600:
                return value
        current = current.__cause__ or current.__context__
    return None


def _chain_text(exc: BaseException) -> str:
    parts, current = [], exc
    while current is not None and len(parts) < 5:
        parts.append(str(current))
        current = current.__cause__ or current.__context__
    return " ".join(parts).lower()


def classify_model_error(exc: BaseException) -> ChatError:
    status = _status_code(exc)
    text = _chain_text(exc)
    if status == 402 or "payment required" in text or "prepay" in text:
        return ChatError(
            "ai_credits_exhausted",
            "The AI analyst is out of credits right now. Please try again later.",
            retryable=False,
        )
    if isinstance(exc, ModelRateLimitError) or status == 429:
        return ChatError(
            "ai_rate_limited",
            "The AI analyst is busy right now. Please wait a moment and try again.",
            retryable=True,
        )
    if isinstance(exc, ModelTimeoutError | TimeoutError):
        return ChatError(
            "ai_timeout",
            "The AI analyst took too long to respond. Please try again.",
            retryable=True,
        )
    if status == 400 and ("failed_precondition" in text or "billing" in text):
        return ChatError(
            "ai_unavailable",
            "The AI analyst is unavailable (billing is not set up).",
            retryable=False,
        )
    if status is not None and status >= 500:
        return ChatError(
            "ai_unavailable",
            "The AI analyst is temporarily unavailable. Please try again.",
            retryable=True,
        )
    return ChatError(
        "chat_failed",
        "Something went wrong while answering. Please try again.",
        retryable=True,
        expected=False,
    )
