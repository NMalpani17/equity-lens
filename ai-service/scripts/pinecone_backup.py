"""Export the Pinecone index to files, and restore it from them.

Usage (from ai-service/):
    python -m scripts.pinecone_backup export --out DIR [--previous MANIFEST]
    gcloud storage ls 'gs://BUCKET/**/pinecone/manifest.json' \\
        | python -m scripts.pinecone_backup latest    # the newest export's folder
    python -m scripts.pinecone_backup restore --from DIR --index NAME         # dry run
    python -m scripts.pinecone_backup restore --from DIR --index NAME --yes   # writes

``export`` is read-only: it lists every vector ID in every namespace, fetches
the vectors (dense values, sparse values and metadata) and writes one gzipped
JSONL file per namespace plus ``manifest.json`` (index configuration, counts,
SHA-256 hashes, the change fingerprint and the bytes read). It fails if a
fetched vector is missing or the exported count doesn't match the index stats.

Reading every vector counts against Pinecone's monthly read limit, so with
``--previous`` (the latest export's manifest) it first compares a fingerprint
that reads no vectors: the index stats (vector count per namespace) and the
ingestion watermark in Postgres (job and ticker counts and timestamps, which
every index write moves; see ``RagRepository.index_watermark``). It skips the
export when nothing changed, unless the latest export is ``--max-age-days``
old or ``--force`` is given, and also when another export would take this
month's export reads past ``--budget-mb``. ``--decision`` writes the outcome
as JSON, including where the latest valid export is.

``restore`` upserts an export into the index named by ``--index`` (required;
there is no default, because local settings point at production). Without
``--yes`` it only prints the plan. It verifies the file hashes first, and
refuses a target namespace that already has vectors unless
``--allow-nonempty`` is given (upserts overwrite vectors with the same ID).
``--create-index`` creates a missing index with the exported configuration.
"""

import argparse
import gzip
import hashlib
import json
import re
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TextIO

FORMAT_VERSION = 1
MANIFEST = "manifest.json"
# IDs per fetch request and vectors per upsert request.
FETCH_BATCH = 100
UPSERT_BATCH = 100
MB = 1_000_000
DEFAULT_MAX_AGE_DAYS = 7
DEFAULT_BUDGET_MB = 600
# A backup folder's timestamp, e.g. daily/2026/10/31/20261031T070012Z/ or
# pre-migrate/20261031T070012Z-abc1234/, directly above pinecone/manifest.json.
_EXPORT_MANIFEST = re.compile(r"/(\d{8}T\d{6}Z)[^/]*/pinecone/manifest\.json$")


class BackupError(Exception):
    """The export or restore can't be trusted; nothing more is written."""


@dataclass(frozen=True)
class IndexConfig:
    name: str
    dimension: int
    metric: str
    cloud: str | None = None
    region: str | None = None


def _batches(items: Sequence[str], size: int) -> Iterator[Sequence[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _file_name(namespace: str) -> str:
    # The default namespace is "", which can't be a file name.
    return f"{namespace or '__default__'}.jsonl.gz"


def _namespace_counts(index: Any) -> dict[str, int]:
    stats = index.describe_index_stats()
    return {
        name: int(summary.vector_count) for name, summary in stats.namespaces.items()
    }


def list_ids(index: Any, namespace: str) -> list[str]:
    ids: list[str] = []
    for page in index.list(namespace=namespace):
        ids.extend(item.id for item in page.vectors if item.id)
    return ids


@dataclass(frozen=True)
class NamespaceExport:
    count: int
    # Approximate bytes read from Pinecone: the listed IDs plus each fetched
    # vector serialized as JSON (what the export writes, before gzip).
    bytes_read: int


def vector_record(vector: Any) -> dict[str, Any]:
    sparse = vector.sparse_values
    return {
        "id": vector.id,
        "values": list(vector.values or []),
        "sparse_values": (
            {"indices": list(sparse.indices), "values": list(sparse.values)}
            if sparse is not None and sparse.indices
            else None
        ),
        "metadata": dict(vector.metadata or {}),
    }


def export_namespace(index: Any, namespace: str, path: Path) -> NamespaceExport:
    """Write every vector in ``namespace`` to ``path``."""
    ids = list_ids(index, namespace)
    written = 0
    bytes_read = sum(len(i.encode()) for i in ids)
    with gzip.open(path, "wt", encoding="utf-8") as out:
        for batch in _batches(ids, FETCH_BATCH):
            fetched = index.fetch(ids=list(batch), namespace=namespace).vectors
            missing = [i for i in batch if i not in fetched]
            if missing:
                raise BackupError(
                    f"{len(missing)} listed vectors in {namespace!r} could not be "
                    f"fetched, e.g. {missing[:3]}"
                )
            for vector_id in batch:
                line = json.dumps(vector_record(fetched[vector_id])) + "\n"
                out.write(line)
                bytes_read += len(line.encode())
                written += 1
    return NamespaceExport(written, bytes_read)


def make_fingerprint(
    config: IndexConfig, counts: dict[str, int], watermark: dict[str, Any]
) -> dict[str, Any]:
    """What the change check compares; read without fetching any vector.

    Normalized through JSON so it compares equal to one read from a manifest.
    """
    return json.loads(
        json.dumps(
            {"index": config.__dict__, "namespaces": counts, "watermark": watermark},
            sort_keys=True,
        )
    )


def _month(moment: datetime) -> str:
    return moment.strftime("%Y-%m")


def export_index(
    index: Any,
    config: IndexConfig,
    out_dir: Path,
    *,
    counts: dict[str, int] | None = None,
    fingerprint: dict[str, Any] | None = None,
    month_bytes_before: int = 0,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, Any]:
    """Export every namespace to ``out_dir`` and write the manifest.

    ``counts`` are the index stats the fingerprint was taken from (read here
    if not given). ``month_bytes_before`` is this month's export reads so far.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    expected = _namespace_counts(index) if counts is None else counts
    created = now()
    namespaces: dict[str, Any] = {}
    for namespace in sorted(expected):
        path = out_dir / _file_name(namespace)
        exported = export_namespace(index, namespace, path)
        if exported.count != expected[namespace]:
            raise BackupError(
                f"exported {exported.count} vectors from {namespace!r} but the "
                f"index stats report {expected[namespace]}"
            )
        namespaces[namespace] = {
            "file": path.name,
            "count": exported.count,
            "sha256": _sha256(path),
            "bytes_read": exported.bytes_read,
        }
    bytes_read = sum(n["bytes_read"] for n in namespaces.values())
    manifest = {
        "format_version": FORMAT_VERSION,
        "created_at": created.isoformat(),
        "index": config.__dict__,
        "namespaces": namespaces,
        "total_vectors": sum(n["count"] for n in namespaces.values()),
        "fingerprint": fingerprint,
        "bytes_read": bytes_read,
        "month": _month(created),
        "month_bytes_read": month_bytes_before + bytes_read,
    }
    (out_dir / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


@dataclass(frozen=True)
class Decision:
    export: bool
    reason: str
    # This month's export reads before this run (from the latest export).
    month_bytes_before: int = 0
    # Changed but skipped (over budget): the vector backup is stale.
    warning: bool = False


def _what_changed(current: dict[str, Any], previous: dict[str, Any]) -> list[str]:
    changes = []
    if current["index"] != previous.get("index"):
        changes.append("index configuration changed")
    before, after = previous.get("namespaces", {}), current["namespaces"]
    for namespace in sorted(set(before) | set(after)):
        if before.get(namespace) != after.get(namespace):
            changes.append(
                f"{namespace or '(default)'}: {before.get(namespace, 0)} -> "
                f"{after.get(namespace, 0)} vectors"
            )
    if current["watermark"] != previous.get("watermark"):
        changes.append("index writes recorded since the latest export")
    return changes


def decide(
    fingerprint: dict[str, Any],
    previous: dict[str, Any] | None,
    *,
    now: datetime,
    max_age: timedelta,
    budget_bytes: int,
    force: bool = False,
) -> Decision:
    """Whether to export, given the latest export's manifest (if any)."""
    if previous is None:
        return Decision(True, "no earlier vector export")
    month_before = (
        int(previous.get("month_bytes_read") or 0)
        if previous.get("month") == _month(now)
        else 0
    )
    if force:
        return Decision(True, "forced", month_before)

    created = datetime.fromisoformat(previous["created_at"])
    previous_fingerprint = previous.get("fingerprint")
    if previous_fingerprint is None:
        reasons = ["the latest export has no fingerprint"]
    else:
        reasons = _what_changed(fingerprint, previous_fingerprint)
    if now - created >= max_age:
        reasons.append(f"the latest export is {(now - created).days} days old")
    if not reasons:
        return Decision(
            False, f"unchanged since the export of {previous['created_at']}"
        )

    reason = "; ".join(reasons)
    estimate = int(previous.get("bytes_read") or 0)
    if month_before + estimate > budget_bytes:
        return Decision(
            False,
            f"{reason}, but another export (~{estimate / MB:.0f} MB) would take "
            f"this month's export reads past {budget_bytes / MB:.0f} MB "
            f"(used {month_before / MB:.0f} MB); keeping the latest export",
            month_before,
            warning=True,
        )
    return Decision(True, reason, month_before)


def latest_export(listing: Iterable[str]) -> str | None:
    """The newest export's folder (``.../pinecone/``) in a bucket listing."""
    found = [
        (match.group(1), url)
        for url in (line.strip() for line in listing)
        if (match := _EXPORT_MANIFEST.search(url))
    ]
    return max(found)[1].removesuffix(MANIFEST) if found else None


def load_manifest(backup_dir: Path) -> dict[str, Any]:
    """Read the manifest and verify every namespace file's hash."""
    manifest = json.loads((backup_dir / MANIFEST).read_text(encoding="utf-8"))
    if manifest.get("format_version") != FORMAT_VERSION:
        raise BackupError(
            f"unsupported format_version {manifest.get('format_version')}"
        )
    for namespace, entry in manifest["namespaces"].items():
        path = backup_dir / entry["file"]
        if not path.is_file():
            raise BackupError(f"missing file {entry['file']} for {namespace!r}")
        if _sha256(path) != entry["sha256"]:
            raise BackupError(f"{entry['file']} does not match its SHA-256 hash")
    return manifest


def read_records(path: Path) -> Iterator[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def upsert_record(record: dict[str, Any]) -> dict[str, Any]:
    vector: dict[str, Any] = {
        "id": record["id"],
        "values": record["values"],
        "metadata": record["metadata"],
    }
    if record.get("sparse_values"):
        vector["sparse_values"] = record["sparse_values"]
    return vector


def restore_namespace(
    index: Any, records: Iterable[dict[str, Any]], namespace: str
) -> int:
    restored = 0
    batch: list[dict[str, Any]] = []
    for record in records:
        batch.append(upsert_record(record))
        if len(batch) == UPSERT_BATCH:
            index.upsert(vectors=batch, namespace=namespace, show_progress=False)
            restored += len(batch)
            batch = []
    if batch:
        index.upsert(vectors=batch, namespace=namespace, show_progress=False)
        restored += len(batch)
    return restored


@dataclass(frozen=True)
class RestoreStep:
    source: str
    target: str
    count: int
    target_count: int


def plan_restore(
    manifest: dict[str, Any],
    target_counts: dict[str, int],
    *,
    namespaces: Sequence[str] | None,
    namespace_map: dict[str, str],
    allow_nonempty: bool,
) -> list[RestoreStep]:
    """What would be restored where; raises if a step isn't allowed."""
    available = manifest["namespaces"]
    chosen = list(namespaces) if namespaces else sorted(available)
    unknown = [n for n in chosen if n not in available]
    if unknown:
        raise BackupError(f"not in this backup: {unknown}")
    steps = []
    for source in chosen:
        target = namespace_map.get(source, source)
        existing = target_counts.get(target, 0)
        if existing and not allow_nonempty:
            raise BackupError(
                f"target namespace {target!r} already has {existing} vectors; "
                "pass --allow-nonempty to upsert into it anyway"
            )
        steps.append(RestoreStep(source, target, available[source]["count"], existing))
    return steps


def _parse_map(pairs: Sequence[str]) -> dict[str, str]:
    mapping = {}
    for pair in pairs:
        source, sep, target = pair.partition("=")
        if not sep or not source:
            raise BackupError(f"--namespace-map expects SOURCE=TARGET, got {pair!r}")
        mapping[source] = target
    return mapping


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export", help="export every namespace (read-only)")
    export.add_argument("--out", type=Path, required=True)
    export.add_argument(
        "--previous", type=Path, help="the latest export's manifest.json, if any"
    )
    export.add_argument("--previous-location", help="where that export is stored")
    export.add_argument("--location", help="where this export will be stored")
    export.add_argument(
        "--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS, metavar="DAYS"
    )
    export.add_argument("--budget-mb", type=int, default=DEFAULT_BUDGET_MB)
    export.add_argument("--force", action="store_true", help="export even if unchanged")
    export.add_argument("--decision", type=Path, help="write the outcome as JSON")

    commands.add_parser(
        "latest", help="print the newest export folder from a listing on stdin"
    )

    restore = commands.add_parser("restore", help="upsert an export into an index")
    restore.add_argument("--from", dest="source", type=Path, required=True)
    restore.add_argument("--index", required=True, help="target index (no default)")
    restore.add_argument("--namespaces", nargs="*", help="only these namespaces")
    restore.add_argument(
        "--namespace-map", nargs="*", default=[], metavar="SOURCE=TARGET"
    )
    restore.add_argument("--allow-nonempty", action="store_true")
    restore.add_argument("--create-index", action="store_true")
    restore.add_argument("--yes", action="store_true", help="actually write")
    return parser.parse_args(argv)


def _client() -> Any:
    from pinecone import Pinecone

    from app.config import get_settings

    settings = get_settings()
    if not settings.pinecone_api_key:
        raise BackupError("AI_SERVICE_PINECONE_API_KEY is not set")
    return Pinecone(api_key=settings.pinecone_api_key), settings


def _index_config(pc: Any, name: str) -> IndexConfig:
    description = pc.describe_index(name)
    serverless = getattr(getattr(description, "spec", None), "serverless", None)
    return IndexConfig(
        name=name,
        dimension=int(description.dimension),
        metric=str(description.metric),
        cloud=getattr(serverless, "cloud", None),
        region=getattr(serverless, "region", None),
    )


def _now() -> datetime:
    return datetime.now(UTC)


def _index_watermark(settings: Any) -> dict[str, Any]:
    from app.services.rag.repository import RagRepository, create_pool

    if not settings.database_url:
        raise BackupError("DATABASE_URL is not set (needed for the change check)")
    pool = create_pool(settings.database_url, max_size=1)
    try:
        return RagRepository(pool).index_watermark()
    finally:
        pool.close()


def _read_previous(path: Path | None) -> dict[str, Any] | None:
    """The latest export's manifest; None (so it exports) if absent or unusable."""
    if path is None or not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        datetime.fromisoformat(manifest["created_at"])
    except (ValueError, KeyError, TypeError):
        print(f"warning: ignoring unreadable {path}", file=sys.stderr)  # CLI output
        return None
    return manifest


def run_export(args: argparse.Namespace, pc: Any, settings: Any) -> int:
    name = settings.pinecone_index_name
    index = pc.Index(name=name)
    config = _index_config(pc, name)
    # Taken before any vector is read: a write that lands during the export
    # moves the watermark past this, so the next run exports again.
    counts = _namespace_counts(index)
    fingerprint = make_fingerprint(config, counts, _index_watermark(settings))
    now = _now()
    decision = decide(
        fingerprint,
        _read_previous(args.previous),
        now=now,
        max_age=timedelta(days=args.max_age_days),
        budget_bytes=args.budget_mb * MB,
        force=args.force,
    )

    if decision.export:
        manifest = export_index(
            index,
            config,
            args.out,
            counts=counts,
            fingerprint=fingerprint,
            month_bytes_before=decision.month_bytes_before,
            now=lambda: now,
        )
        for namespace, entry in manifest["namespaces"].items():
            print(  # CLI output
                f"  {namespace or '(default)'}: {entry['count']} vectors, "
                f"{entry['bytes_read']:,} bytes read"
            )
        print(
            f"Exported {manifest['total_vectors']} vectors from {name} to "
            f"{args.out} ({decision.reason}): {manifest['bytes_read']:,} bytes "
            f"read, {manifest['month_bytes_read']:,} this month"
        )
        outcome = {
            "exported": True,
            "latest_export": args.location,
            "bytes_read": manifest["bytes_read"],
            "month_bytes_read": manifest["month_bytes_read"],
        }
    else:
        print(f"Skipped the vector export: {decision.reason}")  # CLI output
        outcome = {
            "exported": False,
            "latest_export": args.previous_location,
            "bytes_read": 0,
            "month_bytes_read": decision.month_bytes_before,
        }
    if args.decision:
        outcome |= {
            "reason": decision.reason,
            "warning": decision.warning,
            "vectors": counts,
            "fingerprint": fingerprint,
        }
        args.decision.write_text(json.dumps(outcome, indent=2), encoding="utf-8")
    return 0


def run_latest(listing: TextIO) -> int:
    folder = latest_export(listing)
    if folder:
        print(folder)  # CLI output
    return 0


def run_restore(args: argparse.Namespace, pc: Any) -> int:
    manifest = load_manifest(args.source)
    exists = pc.has_index(args.index)
    if not exists and not args.create_index:
        raise BackupError(f"index {args.index!r} doesn't exist; pass --create-index")
    target_counts = _namespace_counts(pc.Index(name=args.index)) if exists else {}
    steps = plan_restore(
        manifest,
        target_counts,
        namespaces=args.namespaces,
        namespace_map=_parse_map(args.namespace_map),
        allow_nonempty=args.allow_nonempty,
    )
    print(f"Backup from {manifest['created_at']} -> index {args.index}")  # CLI output
    if not exists:
        print(f"  create index with {manifest['index']}")
    for step in steps:
        print(
            f"  {step.source or '(default)'} -> {step.target or '(default)'}: "
            f"{step.count} vectors (target has {step.target_count})"
        )
    if not args.yes:
        print("Dry run: nothing written. Re-run with --yes to restore.")
        return 0
    if not exists:
        from pinecone import ServerlessSpec

        config = manifest["index"]
        pc.create_index(
            name=args.index,
            dimension=config["dimension"],
            metric=config["metric"],
            spec=ServerlessSpec(cloud=config["cloud"], region=config["region"]),
        )
    index = pc.Index(name=args.index)
    for step in steps:
        path = args.source / manifest["namespaces"][step.source]["file"]
        restored = restore_namespace(index, read_records(path), step.target)
        print(f"  restored {restored} vectors into {step.target or '(default)'}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "latest":
        return run_latest(sys.stdin)
    try:
        pc, settings = _client()
        if args.command == "export":
            return run_export(args, pc, settings)
        return run_restore(args, pc)
    except BackupError as exc:
        print(f"error: {exc}", file=sys.stderr)  # CLI output
        return 1


if __name__ == "__main__":
    sys.exit(main())
