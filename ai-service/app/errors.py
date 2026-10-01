"""Base application error, mapped to JSON by the centralized handler."""

from typing import Any


class AppError(Exception):
    """An error with an HTTP status, a machine-readable code and extra detail."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.detail = detail or {}
