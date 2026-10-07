#!/usr/bin/env bash
# Usage: restore-db.sh <backup dir> <target url> [--allow-remote]
#
# Restores a backup-db.sh dump (public + auth schemas) into an EMPTY Postgres
# database, then checks every table's row count against db-counts.tsv.
#
# Safety:
#   - The target must be on localhost unless --allow-remote is given (only
#     for disaster recovery into a new, empty project; see
#     docs/deployment.md#backups-and-restore). Never point this at production.
#   - The target must have no tables in public or auth.
#   - Objects are restored without owners or grants (--no-owner
#     --no-privileges); the Supabase roles the dump mentions are created as
#     NOLOGIN placeholders if missing.
set -euo pipefail
dir=${1:?usage: restore-db.sh <backup dir> <target url> [--allow-remote]}
target=${2:?usage: restore-db.sh <backup dir> <target url> [--allow-remote]}
allow_remote=${3:-}
here=$(cd "$(dirname "$0")" && pwd)

if [[ ! $target =~ ^postgres(ql)?://([^@/]*@)?(\[[^]]+\]|[^:/?]+) ]]; then
  echo "error: target must be a postgresql:// URL" >&2
  exit 2
fi
host=${BASH_REMATCH[3]}
case "$host" in
  localhost | 127.0.0.1 | "[::1]") ;;
  *)
    if [[ $allow_remote != "--allow-remote" ]]; then
      echo "error: refusing to restore into non-local host '${host}' (pass --allow-remote)" >&2
      exit 2
    fi
    ;;
esac

for file in db.dump db-counts.tsv; do
  [[ -f "${dir}/${file}" ]] || {
    echo "error: ${dir}/${file} not found" >&2
    exit 2
  }
done

existing=$(psql "$target" -XAtqc \
  "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public', 'auth')")
if ((existing > 0)); then
  echo "error: target already has ${existing} tables in public/auth; restore into an empty database" >&2
  exit 2
fi

# Placeholders for roles and schemas a Supabase dump refers to (no-ops on a
# Supabase target, where they already exist).
psql "$target" -Xq -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role',
        'supabase_auth_admin', 'supabase_admin', 'dashboard_user']
    LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END
$$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
SQL

# Every entry except "CREATE SCHEMA public", which already exists.
toc=$(mktemp)
trap 'rm -f "$toc"' EXIT
pg_restore --list "${dir}/db.dump" | grep -vE '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public ' >"$toc"

pg_restore --dbname="$target" --no-owner --no-privileges --exit-on-error \
  --use-list="$toc" "${dir}/db.dump"

actual=$(psql "$target" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -f "${here}/db-counts.sql")
if ! diff <(sort "${dir}/db-counts.tsv") <(sort <<<"$actual"); then
  echo "error: restored row counts differ from the backup (diff above: < backup, > restored)" >&2
  exit 1
fi
echo "Restored $(wc -l <"${dir}/db-counts.tsv") tables; every row count matches the backup."
