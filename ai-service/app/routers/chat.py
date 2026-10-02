"""Analyst chat streaming route (gateway-only, HTTP layer)."""

import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.config import get_settings
from app.errors import AppError
from app.models.chat import ChatTurnRequest
from app.services.chat.agent import ChatEvent, ChatService
from app.services.chat.service import get_chat_service

logger = logging.getLogger(__name__)

# Mounted with the internal-token dependency in app.main (gateway only).
router = APIRouter(prefix="/chat", tags=["chat"])

ChatDep = Annotated[ChatService, Depends(get_chat_service)]


def format_sse(event: ChatEvent) -> str:
    return f"event: {event.type}\ndata: {json.dumps(event.data, default=str)}\n\n"


@router.post(
    "/stream",
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "SSE event stream"},
        401: {"description": "Missing or invalid internal token"},
        422: {"description": "Invalid request or message too long"},
        503: {"description": "Chat is not configured"},
    },
)
async def stream_chat(body: ChatTurnRequest, service: ChatDep) -> StreamingResponse:
    """Run one chat turn and stream it as server-sent events.

    Events: ``token`` {text}, ``tool_start`` {id, name, label, args},
    ``tool_end`` {id, name, ok, summary}, ``chart`` (a price or allocation
    chart built from a tool result), ``done`` {content, status, citations,
    charts, tool_calls, usage, model}, ``error`` {code, message, retryable}. If the
    client disconnects, the generator is cancelled and so is the model call.
    """
    limit = get_settings().chat_max_message_chars
    if len(body.message) > limit:
        raise AppError(
            422,
            "message_too_long",
            f"Messages are limited to {limit} characters.",
            {"limit": limit},
        )

    async def events() -> AsyncIterator[str]:
        async for event in service.stream_turn(body):
            yield format_sse(event)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
