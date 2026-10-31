"""Pinecone export/restore: exact round trip, verification, safe restores, and
exporting only when the index changed."""

import gzip
import io
import json
from datetime import UTC, datetime, timedelta
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


def use_client(
    monkeypatch, client: FakeClient, watermark: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Route the CLI to fakes; returns the (mutable) Postgres watermark."""
    settings = SimpleNamespace(pinecone_index_name="equity-lens-transcripts")
    monkeypatch.setattr(backup, "_client", lambda: (client, settings))
    watermark = {"jobs": 1, "jobs_finished_at": "2026-10-01T07:00:00"} | (
        watermark or {}
    )
    monkeypatch.setattr(backup, "_index_watermark", lambda _settings: dict(watermark))
    return watermark


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


def test_export_records_bytes_read_and_the_fingerprint(tmp_path: Path) -> None:
    source = source_index()
    fingerprint = backup.make_fingerprint(CONFIG, {"transcripts": 5}, {"jobs": 1})
    now = datetime(2026, 11, 3, 7, tzinfo=UTC)

    manifest = backup.export_index(
        source,
        CONFIG,
        tmp_path,
        fingerprint=fingerprint,
        month_bytes_before=1000,
        now=lambda: now,
    )

    per_namespace = [n["bytes_read"] for n in manifest["namespaces"].values()]
    assert all(b > 0 for b in per_namespace)
    assert manifest["bytes_read"] == sum(per_namespace)
    assert manifest["month"] == "2026-11"
    assert manifest["month_bytes_read"] == 1000 + manifest["bytes_read"]
    assert manifest["fingerprint"] == fingerprint
    # The extra fields don't affect restores.
    assert backup.load_manifest(tmp_path) == manifest


NOW = datetime(2026, 11, 10, 7, tzinfo=UTC)
WEEK = timedelta(days=7)
FINGERPRINT = backup.make_fingerprint(
    CONFIG,
    {"transcripts": 5, "transcripts-noctx": 1},
    {"jobs": 3, "jobs_finished_at": "2026-11-01T09:00:00"},
)


def previous_export(**overrides: Any) -> dict[str, Any]:
    return {
        "created_at": (NOW - timedelta(days=1)).isoformat(),
        "fingerprint": FINGERPRINT,
        "bytes_read": 36 * backup.MB,
        "month": "2026-11",
        "month_bytes_read": 100 * backup.MB,
    } | overrides


def changed(**parts: Any) -> dict[str, Any]:
    """FINGERPRINT with some of its parts updated."""
    return FINGERPRINT | {key: FINGERPRINT[key] | value for key, value in parts.items()}


@pytest.mark.parametrize(
    ("previous", "export", "reason"),
    [
        (None, True, "no earlier vector export"),
        (previous_export(), False, "unchanged since"),
        # Re-indexed with the same count: only the Postgres watermark moved.
        (
            previous_export(
                fingerprint=changed(
                    watermark={"jobs_finished_at": "2026-10-30T09:00:00"}
                )
            ),
            True,
            "index writes recorded since the latest export",
        ),
        # Deleted outside the app: only the count moved.
        (
            previous_export(fingerprint=changed(namespaces={"transcripts": 6})),
            True,
            "transcripts: 6 -> 5 vectors",
        ),
        (
            previous_export(fingerprint=changed(index={"dimension": 1536})),
            True,
            "index configuration changed",
        ),
        (previous_export(fingerprint=None), True, "has no fingerprint"),
        (
            previous_export(created_at=(NOW - WEEK).isoformat()),
            True,
            "the latest export is 7 days old",
        ),
    ],
)
def test_decide(previous, export: bool, reason: str) -> None:
    decision = backup.decide(
        FINGERPRINT, previous, now=NOW, max_age=WEEK, budget_bytes=600 * backup.MB
    )

    assert decision.export is export
    assert reason in decision.reason
    assert decision.warning is False


def test_decide_force_exports_an_unchanged_index() -> None:
    decision = backup.decide(
        FINGERPRINT,
        previous_export(),
        now=NOW,
        max_age=WEEK,
        budget_bytes=600 * backup.MB,
        force=True,
    )

    assert (decision.export, decision.reason) == (True, "forced")
    assert decision.month_bytes_before == 100 * backup.MB


def test_decide_keeps_the_latest_export_over_the_monthly_budget() -> None:
    # 570 MB used + a 36 MB export > 600 MB.
    stale = previous_export(fingerprint=None, month_bytes_read=570 * backup.MB)

    decision = backup.decide(
        FINGERPRINT, stale, now=NOW, max_age=WEEK, budget_bytes=600 * backup.MB
    )
    assert decision.export is False and decision.warning is True
    assert "past 600 MB" in decision.reason

    next_month = backup.decide(
        FINGERPRINT,
        stale,
        now=datetime(2026, 12, 1, 7, tzinfo=UTC),
        max_age=WEEK,
        budget_bytes=600 * backup.MB,
    )
    assert next_month.export is True and next_month.month_bytes_before == 0


def test_latest_export_picks_the_newest_backup_folder() -> None:
    bucket = "gs://b"
    listing = [
        f"{bucket}/daily/2026/11/02/20261102T070000Z/pinecone/manifest.json",
        f"{bucket}/pre-migrate/20261102T120000Z-abc1234/pinecone/manifest.json",
        f"{bucket}/daily/2026/11/01/20261101T070000Z/pinecone/manifest.json",
        f"{bucket}/daily/2026/11/03/20261103T070000Z/manifest.json",  # skipped day
        f"{bucket}/daily/2026/11/03/20261103T070000Z/db/db.dump",
        "",
    ]

    assert backup.latest_export(listing) == (
        f"{bucket}/pre-migrate/20261102T120000Z-abc1234/pinecone/"
    )
    assert backup.latest_export([]) is None


def test_cli_latest_reads_a_listing_from_stdin(monkeypatch, capsys) -> None:
    url = "gs://b/manual/20261101T080000Z-abc1234/pinecone/manifest.json"
    monkeypatch.setattr("sys.stdin", io.StringIO(url + "\n"))

    assert backup.main(["latest"]) == 0  # no Pinecone client needed
    assert capsys.readouterr().out == url.removesuffix("manifest.json") + "\n"


BUCKET = "gs://equity-lens-backups-test"


class BackupDays:
    """Runs backup.yml's Pinecone steps against a local folder standing in for
    the bucket: find the latest export, then export to this run's folder or
    skip, recording the decision."""

    def __init__(self, root: Path, monkeypatch) -> None:
        self.root = root / "bucket"
        self.decisions = root / "decisions"
        self.decisions.mkdir()
        self.monkeypatch = monkeypatch

    def local(self, url: str) -> Path:
        return self.root / url.removeprefix(f"{BUCKET}/")

    def listing(self) -> list[str]:
        return [
            f"{BUCKET}/{p.relative_to(self.root).as_posix()}"
            for p in self.root.rglob("*")
            if p.is_file()
        ]

    def run(self, prefix: str, when: datetime, *extra: str) -> dict[str, Any]:
        self.monkeypatch.setattr(backup, "_now", lambda: when)
        previous = backup.latest_export(self.listing()) if self.root.exists() else None
        decision = self.decisions / f"{when:%Y%m%dT%H%M%SZ}.json"
        args = [
            "export",
            "--out",
            str(self.local(f"{BUCKET}/{prefix}/pinecone")),
            "--location",
            f"{BUCKET}/{prefix}/pinecone/",
            "--decision",
            str(decision),
            *extra,
        ]
        if previous:
            args += [
                "--previous",
                str(self.local(previous) / backup.MANIFEST),
                "--previous-location",
                previous,
            ]
        assert backup.main(args) == 0
        return json.loads(decision.read_text())

    def restore(self, folder: str) -> FakeIndex:
        """Restore the export a backup points at into an empty index."""
        source = self.local(folder)
        manifest = backup.load_manifest(source)
        target = FakeIndex()
        for namespace, entry in manifest["namespaces"].items():
            records = backup.read_records(source / entry["file"])
            backup.restore_namespace(target, records, namespace)
        return target


def snapshot(index: FakeIndex) -> dict[str, dict[str, Any]]:
    return {
        namespace: {i: backup.vector_record(v) for i, v in vectors.items()}
        for namespace, vectors in index.data.items()
    }


def test_restore_works_after_exported_and_skipped_days(
    tmp_path: Path, monkeypatch
) -> None:
    source = source_index()
    watermark = use_client(monkeypatch, FakeClient({"equity-lens-transcripts": source}))
    days = BackupDays(tmp_path, monkeypatch)

    def day(n: int, hour: int = 7) -> datetime:
        return datetime(2026, 11, n, hour, tzinfo=UTC)

    # Nov 1: nothing exported yet -> export.
    first = days.run("daily/2026/11/01/20261101T070000Z", day(1))
    assert first["exported"] is True and first["bytes_read"] > 0
    assert first["latest_export"] == (
        f"{BUCKET}/daily/2026/11/01/20261101T070000Z/pinecone/"
    )
    assert snapshot(days.restore(first["latest_export"])) == snapshot(source)

    # Nov 2: unchanged -> skipped; no vectors read, Nov 1 stays the latest.
    second = days.run("daily/2026/11/02/20261102T070000Z", day(2))
    assert second["exported"] is False and second["bytes_read"] == 0
    assert second["latest_export"] == first["latest_export"]
    assert not days.local(f"{BUCKET}/daily/2026/11/02").exists()
    assert snapshot(days.restore(second["latest_export"])) == snapshot(source)

    # Nov 3: a ticker re-indexed with new values and the same vector count.
    source.data["transcripts"]["NVDA#FY2027Q2#0"] = SimpleNamespace(
        **vars(vector("NVDA#FY2027Q2#0")) | {"values": [0.9, 0.8, 0.7]}
    )
    watermark["jobs_finished_at"] = "2026-11-02T15:30:00"
    third = days.run("daily/2026/11/03/20261103T070000Z", day(3))
    assert third["exported"] is True
    assert "index writes recorded" in third["reason"]
    assert third["vectors"] == first["vectors"]  # the counts alone wouldn't show it
    assert third["month_bytes_read"] == first["bytes_read"] + third["bytes_read"]
    restored = days.restore(third["latest_export"])
    assert snapshot(restored) == snapshot(source)
    assert restored.data["transcripts"]["NVDA#FY2027Q2#0"].values == [0.9, 0.8, 0.7]

    # A pre-migrate backup later that day: unchanged -> skipped.
    premigrate = days.run("pre-migrate/20261103T120000Z-abc1234", day(3, 12))
    assert premigrate["exported"] is False
    assert premigrate["latest_export"] == third["latest_export"]

    # Nov 4: changed, but over the monthly budget -> keep the Nov 3 export.
    watermark["jobs_finished_at"] = "2026-11-03T18:00:00"
    over = days.run("daily/2026/11/04/20261104T070000Z", day(4), "--budget-mb", "0")
    assert over["exported"] is False and over["warning"] is True
    assert over["latest_export"] == third["latest_export"]

    # Nov 10: the Nov 3 change is still unexported, and the latest export is a
    # week old; within budget again -> exported.
    later = days.run("daily/2026/11/10/20261110T070000Z", day(10))
    assert later["exported"] is True
    assert "index writes recorded" in later["reason"]
    assert "7 days old" in later["reason"]
    assert snapshot(days.restore(later["latest_export"])) == snapshot(source)


def test_an_unreadable_previous_manifest_means_export(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    use_client(monkeypatch, FakeClient({"equity-lens-transcripts": source_index()}))
    broken = tmp_path / "previous.json"
    broken.write_text("{not json", encoding="utf-8")
    decision = tmp_path / "decision.json"

    code = backup.main(
        [
            "export",
            "--out",
            str(tmp_path / "out"),
            "--previous",
            str(broken),
            "--decision",
            str(decision),
        ]
    )

    assert code == 0
    assert json.loads(decision.read_text())["exported"] is True
    assert "ignoring unreadable" in capsys.readouterr().err
