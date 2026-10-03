# syntax=docker/dockerfile:1
# ai-service: FastAPI + LangGraph agent. Build from ai-service/:
#   docker build -t equity-lens-ai-service .
# Cloud Run injects PORT; locally it defaults to 8000.

ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.lock .
# Exact versions from the lock (no resolver, no drift between builds). The
# compiled bytecode stays (faster cold starts); pip itself isn't needed at runtime.
RUN pip install --no-deps -r requirements.lock     && pip uninstall -y pip

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH \
    AI_SERVICE_ENVIRONMENT=production
# Unprivileged user with a home directory (yfinance keeps a small cache there).
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY app ./app
USER app
EXPOSE 8000
# exec: uvicorn is PID 1 and receives SIGTERM directly. Open requests get 3s
# to finish, then the lifespan stops ingestion and flushes traces (bounded),
# all inside Cloud Run's ~10s shutdown grace period.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --timeout-graceful-shutdown 3"]
