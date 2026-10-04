"""Every ai-service route except /health requires the internal token."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

PUBLIC_PATHS = {"/health"}


def protected_routes() -> list[tuple[str, str]]:
    """Every documented API route except the public ones.

    Built from the OpenAPI schema: FastAPI 0.14x mounts included routers
    lazily, so app.routes doesn't list their endpoints.
    """
    routes = []
    for path, operations in app.openapi()["paths"].items():
        if path in PUBLIC_PATHS:
            continue
        routes.extend((method.upper(), path) for method in sorted(operations))
    return routes


def concrete(path: str) -> str:
    return path.replace("{ticker}", "AAPL")


def test_route_inventory_covers_quotes_rag_and_chat() -> None:
    paths = {path for _, path in protected_routes()}

    assert {"/quotes", "/quotes/{ticker}", "/rag/search", "/rag/tickers"} <= paths
    assert {"/rag/tickers/{ticker}", "/chat/stream"} <= paths


@pytest.mark.parametrize(("method", "path"), protected_routes())
@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong-token"}])
def test_protected_routes_reject_missing_or_wrong_token(method, path, headers) -> None:
    res = TestClient(app).request(method, concrete(path), headers=headers, json={})

    assert res.status_code == 401, (method, path)
    assert res.json()["error"] == "unauthorized"


def test_health_stays_public() -> None:
    assert TestClient(app).get("/health").status_code == 200


def test_unconfigured_token_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "internal_token", "")

    res = TestClient(app).get("/quotes/AAPL", headers={"X-Internal-Token": ""})

    assert res.status_code == 503


def test_mcp_endpoint_requires_the_token() -> None:
    with TestClient(app) as client:
        assert client.post("/mcp/", json={}).status_code == 401


def test_the_internal_token_is_not_accepted_as_a_bearer_token(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "internal_token", "secret-token")

    res = TestClient(app).get(
        "/quotes/AAPL", headers={"Authorization": "Bearer secret-token"}
    )

    assert res.status_code == 401


def test_an_iam_bearer_token_and_the_internal_header_work_together(monkeypatch) -> None:
    """Behind Cloud Run IAM, Authorization carries Google's ID token."""
    monkeypatch.setattr(get_settings(), "internal_token", "secret-token")

    res = TestClient(app).request(
        "POST",
        "/rag/search",
        headers={
            "Authorization": "Bearer google-id-token",
            "X-Internal-Token": "secret-token",
        },
        json={},
    )

    assert res.status_code != 401  # past auth (here: a validation error)
