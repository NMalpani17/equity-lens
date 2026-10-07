"""Pinecone export/restore: exact round trip, verification, and safe restores."""

import gzip
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from scripts import pinecone_backup as backup
from scripts.pinecone_backup import BackupError, IndexConfig

CONFIG = IndexConfig(
    name="equity-lens-transcripts",
    dimension=3,
    metric="dotproduct",
    cloud="aws",
    region="us-east-1",
)


def vector(vector_id: str, *, sparse: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        id=vector_id,
        values=[0.1, -0.25, 1 / 3],
        sparse_values=SimpleNamespace(indices=[4, 17], values=[0.5, 0.125])
        if sparse
        else None,
        metadata={"ticker": "NVDA", "fiscal_year": 2027, "text": "Data center…"},
    )


class FakeIndex:
    """Pages of 2 IDs, like Pinecone's paginated list."""

    def __init__(self, namespaces: dict[str, list[SimpleNamespace]] | None = None):
        self.data: dict[str, dict[str, Any]] = {
            ns: {v.id: v for v in vectors} for ns, vectors in (namespaces or {}).items()
        }
        self.stats_override: dict[str, int] = {}
        self.unfetchable: set[str] = set()
        self.upserts: list[tuple[str, int]] = []

    def describe_index_stats(self) -> SimpleNamespace:
        counts = {ns: len(v) for ns, v in self.data.items()} | self.stats_override
        return SimpleNamespace(
            namespaces={ns: SimpleNamespace(vector_count=n) for ns, n in counts.items()}
        )

    def fetch(self, *, ids: list[str], namespace: str) -> SimpleNamespace:
        stored = self.data.get(namespace, {})
        return SimpleNamespace(
            vectors={
                i: stored[i] for i in ids if i in stored and i not in self.unfetchable
            }
        )

    def upsert(self, *, vectors: list[dict], namespace: str, show_progress: bool):
        target = self.data.setdefault(namespace, {})
        for v in vectors:
            sparse = v.get("sparse_values")
            target[v["id"]] = SimpleNamespace(
                id=v["id"],
                values=v["values"],
                sparse_values=SimpleNamespace(**sparse) if sparse else None,
                metadata=v["metadata"],
            )
        self.upserts.append((namespace, len(vectors)))

    # Last, so the name doesn't shadow the builtin in the annotations above.
    def list(self, *, namespace: str):
        ids = list(self.data.get(namespace, {}))
        for start in range(0, len(ids), 2):
            yield SimpleNamespace(
                vectors=[SimpleNamespace(id=i) for i in ids[start : start + 2]]
            )


def source_index() -> FakeIndex:
    return FakeIndex(
        {
            "transcripts": [vector(f"NVDA#FY2027Q2#{i}") for i in range(5)],
            "transcripts-noctx": [vector("NVDA#FY2027Q2#0", sparse=False)],
            "": [vector("default-1")],
        }
    )


def test_export_then_restore_is_an_exact_round_trip(tmp_path: Path) -> None:
    source = source_index()
    manifest = backup.export_index(source, CONFIG, tmp_path)

    assert manifest["total_vectors"] == 7
    assert manifest["index"]["metric"] == "dotproduct"
    assert manifest["namespaces"][""]["file"] == "__default__.jsonl.gz"
    assert backup.load_manifest(tmp_path) == manifest

    target = FakeIndex()
    for namespace, entry in manifest["namespaces"].items():
        records = backup.read_records(tmp_path / entry["file"])
        backup.restore_namespace(target, records, namespace)

    for namespace, vectors in source.data.items():
        assert {
            i: backup.vector_record(v) for i, v in target.data[namespace].items()
        } == {i: backup.vector_record(v) for i, v in vectors.items()}
    # Exact floats survive JSON, and a vector without sparse values stays so.
    restored = target.data["transcripts"]["NVDA#FY2027Q2#0"]
    assert restored.values == [0.1, -0.25, 1 / 3]
    assert target.data["transcripts-noctx"]["NVDA#FY2027Q2#0"].sparse_values is None


def test_restore_upserts_in_batches(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(backup, "UPSERT_BATCH", 2)
    target = FakeIndex()
    records = [backup.vector_record(vector(f"id-{i}")) for i in range(5)]

    assert backup.restore_namespace(target, records, "transcripts") == 5
    assert target.upserts == [
        ("transcripts", 2),
        ("transcripts", 2),
        ("transcripts", 1),
    ]


def test_export_fails_when_counts_disagree_with_index_stats(tmp_path: Path) -> None:
    source = source_index()
    source.stats_override = {"transcripts": 6}

    with pytest.raises(BackupError, match="stats report 6"):
        backup.export_index(source, CONFIG, tmp_path)


def test_export_fails_when_a_listed_vector_cannot_be_fetched(tmp_path: Path) -> None:
    source = source_index()
    source.unfetchable = {"NVDA#FY2027Q2#3"}

    with pytest.raises(BackupError, match="could not be fetched"):
        backup.export_index(source, CONFIG, tmp_path)


def test_a_modified_or_missing_file_is_rejected(tmp_path: Path) -> None:
    backup.export_index(source_index(), CONFIG, tmp_path)
    path = tmp_path / "transcripts.jsonl.gz"
    with gzip.open(path, "at", encoding="utf-8") as handle:
        handle.write('{"id": "forged"}\n')

    with pytest.raises(BackupError, match="SHA-256"):
        backup.load_manifest(tmp_path)

    path.unlink()
    with pytest.raises(BackupError, match="missing file"):
        backup.load_manifest(tmp_path)


def test_plan_refuses_a_nonempty_target_unless_allowed(tmp_path: Path) -> None:
    manifest = backup.export_index(source_index(), CONFIG, tmp_path)

    with pytest.raises(BackupError, match="already has 4 vectors"):
        backup.plan_restore(
            manifest,
            {"transcripts": 4},
            namespaces=None,
            namespace_map={},
            allow_nonempty=False,
        )

    steps = backup.plan_restore(
        manifest,
        {"transcripts": 4},
        namespaces=["transcripts"],
        namespace_map={"transcripts": "restored"},
        allow_nonempty=False,
    )
    assert steps == [backup.RestoreStep("transcripts", "restored", 5, 0)]

    with pytest.raises(BackupError, match="not in this backup"):
        backup.plan_restore(
            manifest, {}, namespaces=["nope"], namespace_map={}, allow_nonempty=False
        )


class FakeClient:
    def __init__(self, indexes: dict[str, FakeIndex]) -> None:
        self.indexes = indexes
        self.created: list[dict] = []

    def has_index(self, name: str) -> bool:
        return name in self.indexes

    def Index(self, *, name: str) -> FakeIndex:  # noqa: N802 (Pinecone's API)
        return self.indexes[name]

    def describe_index(self, name: str) -> SimpleNamespace:
        return SimpleNamespace(
            dimension=3,
            metric="dotproduct",
            spec=SimpleNamespace(
                serverless=SimpleNamespace(cloud="aws", region="us-east-1")
            ),
        )

    def create_index(self, **kwargs: Any) -> None:
        self.created.append(kwargs)
        self.indexes[kwargs["name"]] = FakeIndex()


def use_client(monkeypatch, client: FakeClient) -> None:
    settings = SimpleNamespace(pinecone_index_name="equity-lens-transcripts")
    monkeypatch.setattr(backup, "_client", lambda: (client, settings))


def test_cli_export_writes_the_manifest(tmp_path: Path, monkeypatch, capsys) -> None:
    use_client(monkeypatch, FakeClient({"equity-lens-transcripts": source_index()}))

    assert backup.main(["export", "--out", str(tmp_path)]) == 0
    assert backup.load_manifest(tmp_path)["total_vectors"] == 7
    assert "Exported 7 vectors" in capsys.readouterr().out


def test_cli_restore_is_a_dry_run_without_yes(tmp_path: Path, monkeypatch, capsys):
    backup.export_index(source_index(), CONFIG, tmp_path)
    target = FakeIndex()
    use_client(monkeypatch, FakeClient({"restore-test": target}))

    code = backup.main(["restore", "--from", str(tmp_path), "--index", "restore-test"])

    assert code == 0
    assert target.data == {}
    assert "Dry run: nothing written" in capsys.readouterr().out

    code = backup.main(
        ["restore", "--from", str(tmp_path), "--index", "restore-test", "--yes"]
    )
    assert code == 0
    assert {ns: len(v) for ns, v in target.data.items()} == {
        "": 1,
        "transcripts": 5,
        "transcripts-noctx": 1,
    }


def test_cli_restore_needs_an_explicit_index_and_existing_target(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    backup.export_index(source_index(), CONFIG, tmp_path)
    client = FakeClient({})
    use_client(monkeypatch, client)

    with pytest.raises(SystemExit):
        backup.main(["restore", "--from", str(tmp_path)])  # no --index

    assert backup.main(["restore", "--from", str(tmp_path), "--index", "new"]) == 1
    assert "pass --create-index" in capsys.readouterr().err

    code = backup.main(
        ["restore", "--from", str(tmp_path), "--index", "new", "--create-index"]
    )
    assert code == 0 and client.created == []  # dry run creates nothing


def test_cli_reports_a_refused_restore_without_writing(
    tmp_path: Path, monkeypatch, capsys
):
    backup.export_index(source_index(), CONFIG, tmp_path)
    target = FakeIndex({"transcripts": [vector("existing")]})
    use_client(monkeypatch, FakeClient({"prod": target}))

    code = backup.main(["restore", "--from", str(tmp_path), "--index", "prod", "--yes"])

    assert code == 1
    assert "already has 1 vectors" in capsys.readouterr().err
    assert list(target.data["transcripts"]) == ["existing"]
