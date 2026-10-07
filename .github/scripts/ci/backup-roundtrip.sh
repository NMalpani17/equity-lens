#!/usr/bin/env bash
# Usage: PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#          .github/scripts/ci/backup-roundtrip.sh
#
# End-to-end check of the migrations and the backup scripts against a
# THROWAWAY local Postgres (CI's service container): it creates and drops the
# backup_source / backup_target databases there.
#   1. apply every Prisma migration to a Supabase-like database
#   2. the migrated schema matches schema.prisma (no drift)
#   3. RLS is on for every public table, and anon reads no rows despite grants
#   4. backup-db.sh then restore-db.sh round-trips every row count and RLS
#   5. restore-db.sh refuses a non-empty target and a non-local host
#
# Run from the repo root after `npm ci` in api/ (for the Prisma CLI).
set -euo pipefail
: "${PG_ADMIN_URL:?set PG_ADMIN_URL to a local Postgres admin connection string}"
repo=$(pwd)
scripts="${repo}/.github/scripts"
prisma="${repo}/api/node_modules/.bin/prisma"

if [[ ! $PG_ADMIN_URL =~ ^postgres(ql)?://[^@/]*@(localhost|127\.0\.0\.1)[:/] ]]; then
  echo "error: PG_ADMIN_URL must point at localhost; this script drops databases" >&2
  exit 2
fi
base=${PG_ADMIN_URL%/*}
source_url="${base}/backup_source"
target_url="${base}/backup_target"

fail() {
  echo "::error::$*" >&2
  exit 1
}
step() { echo "--- $*"; }

for db in backup_source backup_target; do
  psql "$PG_ADMIN_URL" -Xq -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${db}" -c "CREATE DATABASE ${db}"
done
psql "$source_url" -Xq -v ON_ERROR_STOP=1 -f "${scripts}/ci/supabase-stub.sql"

# Prisma runs from a copy of api/prisma, away from any api/.env (whose URLs
# point at production), with both URLs set explicitly.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r "${repo}/api/prisma" "${work}/prisma"
run_prisma() {
  (cd "$work" && DATABASE_URL="$source_url" DIRECT_URL="$source_url" "$prisma" "$@")
}

step "apply migrations"
run_prisma migrate deploy --schema prisma/schema.prisma

step "migrations match schema.prisma"
if ! run_prisma migrate diff --from-url "$source_url" \
  --to-schema-datamodel prisma/schema.prisma --exit-code >"${work}/drift.sql"; then
  cat "${work}/drift.sql"
  fail "the migrations don't produce schema.prisma (drift above)"
fi

step "row level security"
off=$(psql "$source_url" -XAtqc "SELECT string_agg(relname, ', ') FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity")
[[ -z $off ]] || fail "RLS is off on: ${off}"

psql "$source_url" -Xq -v ON_ERROR_STOP=1 -f "${scripts}/ci/seed.sql"
anon_rows=$(psql "$source_url" -XAtqc "SET ROLE anon; SELECT count(*) FROM holdings")
((anon_rows == 0)) || fail "anon can read ${anon_rows} holdings rows"

step "backup"
DATABASE_URL="$source_url" "${scripts}/backup-db.sh" "${work}/backup"
grep -qx $'public.holdings\t2' "${work}/backup/db-counts.tsv" ||
  fail "db-counts.tsv is missing public.holdings = 2"
grep -qx $'auth.users\t2' "${work}/backup/db-counts.tsv" ||
  fail "db-counts.tsv is missing auth.users = 2"

step "restore"
"${scripts}/restore-db.sh" "${work}/backup" "$target_url"
off=$(psql "$target_url" -XAtqc "SELECT string_agg(relname, ', ') FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity")
[[ -z $off ]] || fail "RLS was lost in the restore on: ${off}"

step "restore refuses unsafe targets"
set +e
"${scripts}/restore-db.sh" "${work}/backup" "$target_url" 2>/dev/null
nonempty=$?
"${scripts}/restore-db.sh" "${work}/backup" \
  "postgresql://postgres:x@db.example.supabase.co:5432/postgres" 2>/dev/null
remote=$?
set -e
((nonempty == 2)) || fail "restore into a non-empty database exited ${nonempty}, expected 2"
((remote == 2)) || fail "restore into a remote host exited ${remote}, expected 2"

for db in backup_source backup_target; do
  psql "$PG_ADMIN_URL" -Xq -c "DROP DATABASE ${db}"
done
echo "Backup round trip passed."
