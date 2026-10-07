"""Export the Pinecone index to files, and restore it from them.

Usage (from ai-service/):
    python -m scripts.pinecone_backup export --out DIR
    python -m scripts.pinecone_backup restore --from DIR --index NAME         # dry run
    python -m scripts.pinecone_backup restore --from DIR --index NAME --yes   # writes

``export`` is read-only: it lists every vector ID in every namespace, fetches
the vectors (dense values, sparse values and metadata) and writes one gzipped
JSONL file per namespace plus ``manifest.json`` (index configuration, counts
and SHA-256 hashes). It fails if a fetched vector is missing or the exported
count doesn't match the index stats.

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
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

FORMAT_VERSION = 1
MANIFEST = "manifest.json"
# IDs per fetch request and vectors per upsert request.
FETCH_BATCH = 100
UPSERT_BATCH = 100


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


def export_namespace(index: Any, namespace: str, path: Path) -> int:
    """Write every vector in ``namespace`` to ``path``; returns the count."""
    ids = list_ids(index, namespace)
    written = 0
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
                out.write(json.dumps(vector_record(fetched[vector_id])) + "\n")
                written += 1
    return written


def export_index(
    index: Any,
    config: IndexConfig,
    out_dir: Path,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict[str, Any]:
    """Export every namespace to ``out_dir`` and write the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    expected = _namespace_counts(index)
    namespaces: dict[str, Any] = {}
    for namespace in sorted(expected):
        path = out_dir / _file_name(namespace)
        count = export_namespace(index, namespace, path)
        if count != expected[namespace]:
            raise BackupError(
                f"exported {count} vectors from {namespace!r} but the index "
                f"stats report {expected[namespace]}"
            )
        namespaces[namespace] = {
            "file": path.name,
            "count": count,
            "sha256": _sha256(path),
        }
    manifest = {
        "format_version": FORMAT_VERSION,
        "created_at": now().isoformat(),
        "index": config.__dict__,
        "namespaces": namespaces,
        "total_vectors": sum(n["count"] for n in namespaces.values()),
    }
    (out_dir / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


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


def run_export(args: argparse.Namespace, pc: Any, settings: Any) -> int:
    name = settings.pinecone_index_name
    manifest = export_index(pc.Index(name=name), _index_config(pc, name), args.out)
    for namespace, entry in manifest["namespaces"].items():
        print(f"  {namespace or '(default)'}: {entry['count']} vectors")  # CLI output
    print(f"Exported {manifest['total_vectors']} vectors from {name} to {args.out}")
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
