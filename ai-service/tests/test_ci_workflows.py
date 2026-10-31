"""The backup and deploy workflows keep their safety properties.

These parse the GitHub Actions files (the repo has one environment, so CD
writes to production): a backup runs daily and before every migration, it
reads Pinecone's vectors only when the index changed, and no code ships when
a migration it needs didn't run.
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


def step_named(job: dict[str, Any], prefix: str) -> dict[str, Any]:
    return next(s for s in job["steps"] if s.get("name", "").startswith(prefix))


def test_backup_exports_vectors_only_when_changed_within_budget() -> None:
    wf = workflow("backup.yml")
    job = wf["jobs"]["backup"]
    export = step_named(job, "Export Pinecone vectors")["run"]

    # Compared with the newest earlier export, found by listing (never deleting).
    assert "pinecone/manifest.json" in export
    assert "scripts.pinecone_backup latest" in export
    assert "--previous" in export and "--decision" in export
    assert '--budget-mb "$PINECONE_BUDGET_MB"' in export
    assert '--max-age-days "$PINECONE_MAX_AGE_DAYS"' in export
    assert wf["env"]["PINECONE_BUDGET_MB"] == 600
    assert wf["env"]["PINECONE_MAX_AGE_DAYS"] == 7
    # A manual run can force an export.
    force = triggers(wf)["workflow_dispatch"]["inputs"]["force"]
    assert (force["type"], force["default"]) == ("boolean", False)
    assert "--force" in export


def test_a_failed_vector_export_still_uploads_the_database() -> None:
    job = workflow("backup.yml")["jobs"]["backup"]
    names = [s.get("name", "") for s in job["steps"]]
    dump = step_named(job, "Dump the database")
    export = step_named(job, "Export Pinecone vectors")
    upload = step_named(job, "Upload to Cloud Storage")
    fail = step_named(job, "Fail if the vector export failed")

    assert "if" not in dump and "continue-on-error" not in dump
    assert export["id"] == "vectors" and export["continue-on-error"] is True
    assert "if" not in upload  # runs after a failed (continue-on-error) export
    assert fail["if"] == "steps.vectors.outcome == 'failure'"
    assert "exit 1" in fail["run"]
    assert names.index(upload["name"]) < names.index(fail["name"])


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


def test_ci_runs_the_postgres_gated_repository_tests() -> None:
    job = workflow("ci.yml")["jobs"]["backup-roundtrip"]
    step = next(s for s in job["steps"] if "repository_pg" in s.get("run", ""))

    assert "postgres" in job["services"]
    url = step["env"]["AI_SERVICE_TEST_DATABASE_URL"]
    assert url.startswith("postgresql://postgres:postgres@127.0.0.1:5432/")
    for test in (
        "tests/test_rag_repository_pg.py",
        "tests/test_report_repository_pg.py",
        "tests/test_market_repository_pg.py",
        "tests/test_market_symbols_pg.py",
        "tests/test_market_earnings_pg.py",
    ):
        assert test in step["run"]
    assert 'grep -q "SKIPPED"' in step["run"]  # skipped tests fail the job


def test_ci_runs_the_api_integration_tests_on_real_postgres() -> None:
    job = workflow("ci.yml")["jobs"]["backup-roundtrip"]
    script = (REPO / ".github/scripts/ci/api-integration.sh").read_text(
        encoding="utf-8"
    )

    assert ".github/scripts/ci/api-integration.sh" in run_scripts(job)
    assert 'prisma" migrate deploy' in script
    assert "REQUIRE_INTEGRATION_DB=1" in script  # a skipped run fails
    assert "npm run test:integration" in script
