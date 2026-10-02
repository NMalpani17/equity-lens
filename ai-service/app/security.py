"""Internal service authentication (API gateway -> ai-service).

The gateway authenticates end users; the ai-service only trusts the gateway,
proven by a shared secret. Comparisons are constant-time.
"""

import hmac
from typing import Annotated

from fastapi import Header
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings
from app.errors import AppError

INTERNAL_TOKEN_HEADER = "X-Internal-Token"


def token_matches(provided: str | None, expected: str) -> bool:
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def require_internal_token(
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    """FastAPI dependency guarding gateway-only endpoints."""
    expected = get_settings().internal_token
    if not expected:
        raise AppError(
            503,
            "chat_not_configured",
            "internal service token is not configured",
            {"missing": ["AI_SERVICE_INTERNAL_TOKEN"]},
        )
    if not token_matches(x_internal_token, expected):
        raise AppError(401, "unauthorized", "missing or invalid internal token")


class InternalTokenMiddleware:
    """ASGI middleware for mounted sub-apps (the MCP endpoint).

    Accepts ``Authorization: Bearer <token>`` (what MCP clients send) or the
    ``X-Internal-Token`` header.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        auth = headers.get("authorization", "")
        bearer = auth[7:] if auth.lower().startswith("bearer ") else None
        provided = bearer or headers.get(INTERNAL_TOKEN_HEADER.lower())
        if not token_matches(provided, get_settings().internal_token):
            body = (
                b'{"error":"unauthorized",'
                b'"message":"missing or invalid internal token"}'
            )
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
