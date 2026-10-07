"""The backup and deploy workflows keep their safety properties.

These parse the GitHub Actions files (the repo has one environment, so CD
writes to production): a backup runs daily and before every migration, and
no code ships when a migration it needs didn't run.
"""

from pathlib import Path
from typing import Any

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github/workflows"


def workflow(name: str) -> dict[str, Any]:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def triggers(wf: dict[str, Any]) -> dict[str, Any]:
    # YAML 1.1 reads the bare key `on` as True.
    return wf.get("on") or wf[True]


def run_scripts(job: dict[str, Any]) -> str:
    return "\n".join(step.get("run", "") for step in job["steps"])


def test_backup_runs_daily_by_hand_and_when_called() -> None:
    on = triggers(workflow("backup.yml"))

    assert on["schedule"] == [{"cron": "0 7 * * *"}]
    assert "workflow_dispatch" in on
    assert "workflow_call" in on


def test_backup_signs_in_as_the_backup_identity_only() -> None:
    job = workflow("backup.yml")["jobs"]["backup"]
    auth = next(
        s for s in job["steps"] if "google-github-actions/auth" in s.get("uses", "")
    )

    assert job["permissions"] == {"contents": "read", "id-token": "write"}
    assert auth["with"] == {
        "workload_identity_provider": "${{ vars.GCP_BACKUP_WIF_PROVIDER }}",
        "service_account": "${{ vars.GCP_BACKUP_SA }}",
    }


def test_backup_dumps_both_schemas_exports_vectors_and_never_deletes() -> None:
    script = run_scripts(workflow("backup.yml")["jobs"]["backup"])
    dump = (REPO / ".github/scripts/backup-db.sh").read_text(encoding="utf-8")

    assert ".github/scripts/backup-db.sh" in script
    assert "--schema=public --schema=auth" in dump
    assert "scripts.pinecone_backup export" in script
    assert "gcloud storage cp" in script
    # Unique, timestamped destinations; nothing is removed or overwritten.
    assert "${stamp}" in script
    for forbidden in ("gcloud storage rm", "gsutil rm", "--delete", "rsync"):
        assert forbidden not in script


def test_deploy_backs_up_before_any_migration() -> None:
    jobs = workflow("deploy.yml")["jobs"]

    assert jobs["backup"]["uses"] == "./.github/workflows/backup.yml"
    assert jobs["backup"]["with"] == {"reason": "pre-migrate"}
    assert jobs["backup"]["if"] == "needs.changes.outputs.migrations == 'true'"
    assert "backup" in jobs["migrate"]["needs"]
    assert "needs.backup.result == 'success'" in jobs["migrate"]["if"]


@pytest.mark.parametrize("job", ["deploy-ai-service", "deploy-api"])
def test_no_deploy_without_its_migration(job: str) -> None:
    condition = " ".join(workflow("deploy.yml")["jobs"][job]["if"].split())

    # A migrate job skipped because its backup failed must block the deploy.
    assert (
        "(needs.migrate.result == 'success' || "
        "needs.changes.outputs.migrations != 'true')" in condition
    )
    assert "needs.migrate.result)" not in condition  # the old success-or-skipped rule
