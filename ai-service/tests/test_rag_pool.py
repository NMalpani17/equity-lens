"""The Postgres pool replaces connections the pooler dropped while idle."""

from psycopg_pool import ConnectionPool

from app.services.rag import repository


def test_pool_checks_connections_and_drops_idle_ones(monkeypatch) -> None:
    captured: dict = {}

    class FakePool:
        check_connection = ConnectionPool.check_connection

        def __init__(self, conninfo, **kwargs):
            captured.update(kwargs, conninfo=conninfo)

    monkeypatch.setattr(repository, "ConnectionPool", FakePool)

    repository.create_pool(
        "postgresql://u:p@pooler.example:6543/postgres?pgbouncer=true", max_size=5
    )

    assert captured["check"] is ConnectionPool.check_connection
    assert captured["max_idle"] == repository.POOL_MAX_IDLE_SECONDS == 300
    # Supabase's transaction pooler can't use server-side prepared statements.
    assert captured["kwargs"]["prepare_threshold"] is None
    assert "pgbouncer" not in captured["conninfo"]
    assert captured["max_size"] == 5
