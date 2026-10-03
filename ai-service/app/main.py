"""FastAPI application factory and entrypoint."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastmcp.utilities.lifespan import combine_lifespans
from starlette.middleware import Middleware

from app.config import get_settings
from app.errors import AppError
from app.logging_config import configure_logging
from app.routers import chat, health, market, rag
from app.security import InternalTokenMiddleware, require_internal_token
from app.services.chat.mcp_server import mcp
from app.services.observability.tracing import shutdown_tracer
from app.services.rag.container import shutdown_rag_components

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    # Bounded, so a shutdown never hangs: ingestion stops at its next stage
    # (an interrupted job is reclaimed later), then pending traces flush.
    settings = get_settings()
    shutdown_rag_components(settings.shutdown_ingestion_timeout_seconds)
    shutdown_tracer(settings.shutdown_tracing_timeout_seconds)


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    settings = get_settings()
    configure_logging(settings.log_level)

    # The MCP tool server, mounted for MCP clients behind the internal token.
    # Its session manager needs the sub-app lifespan to run.
    mcp_app = mcp.http_app(
        path="/",
        stateless_http=True,
        middleware=[Middleware(InternalTokenMiddleware)],
    )

    app = FastAPI(
        title="Equity Lens AI Service",
        version="0.1.0",
        description="LLM / LangChain / MCP layer for Equity Lens.",
        lifespan=combine_lifespans(lifespan, mcp_app.lifespan),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Only /health is public. Every other route serves the API gateway alone
    # and requires the internal token (checked before the body is parsed).
    app.include_router(health.router)
    internal_only = [Depends(require_internal_token)]
    for router in (market.router, rag.router, chat.router):
        app.include_router(router, dependencies=internal_only)
    app.mount("/mcp", mcp_app)
    _register_error_handlers(app)

    logger.info("ai-service started in %s environment", settings.environment)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    """Centralized error handling for the whole app."""

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        logger.warning("validation error on %s: %s", request.url.path, exc.errors())
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "detail": exc.errors()},
        )

    @app.exception_handler(AppError)
    async def on_app_error(request: Request, exc: AppError) -> JSONResponse:
        log = logger.error if exc.status_code >= 500 else logger.warning
        log("%s on %s: %s", exc.code, request.url.path, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "message": exc.message, **exc.detail},
        )

    @app.exception_handler(Exception)
    async def on_unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error on %s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "internal_server_error"},
        )


app = create_app()
