"""Research report generation route (gateway-only, HTTP layer)."""

import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.models.report import ReportRequest
from app.services.report.service import ReportEvent, ReportService, get_report_service

# Mounted with the internal-token dependency in app.main (gateway only).
router = APIRouter(prefix="/reports", tags=["reports"])

ReportDep = Annotated[ReportService, Depends(get_report_service)]


def format_sse(event: ReportEvent) -> str:
    return f"event: {event.type}\ndata: {json.dumps(event.data, default=str)}\n\n"


@router.post(
    "/stream",
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "SSE event stream"},
        401: {"description": "Missing or invalid internal token"},
        422: {"description": "Invalid request"},
        503: {"description": "Reports are not configured"},
    },
)
async def stream_report(body: ReportRequest, service: ReportDep) -> StreamingResponse:
    """Generate a ticker's report for its latest indexed quarter, as SSE.

    Events: ``agent`` {agent, state, label, summary?} as each agent runs
    (transcripts and market in parallel, then writer); ``done`` {report,
    fiscal_year, fiscal_quarter, generated_at, usage}; ``error`` {code,
    message, retryable}, e.g. ``report_in_progress``, ``report_fresh``,
    ``not_indexed``. The report is saved before ``done``. If the client
    disconnects, the run is cancelled and nothing is saved.
    """

    async def events() -> AsyncIterator[str]:
        async for event in service.stream(body):
            yield format_sse(event)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
