#!/usr/bin/env bash
# Usage: backup-db.sh <out dir>
#
# Dumps the public and auth schemas of $DATABASE_URL (a direct or session
# connection string, never the transaction pooler) into <out dir>:
#   db.dump        pg_dump custom format (restore with restore-db.sh)
#   db-counts.tsv  exact row count of every table, taken just before the dump
#
# Read-only: the counts run in a read-only session and pg_dump only reads.
# Needs pg_dump/psql at least as new as the server (17 for Supabase today).
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a direct or session connection string}"
out=${1:?usage: backup-db.sh <out dir>}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"

client_major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
server_num=$(psql "$DATABASE_URL" -XAtqc "SHOW server_version_num")
server_major=$((server_num / 10000))
if ((client_major < server_major)); then
  echo "::error::pg_dump ${client_major} is older than the server (${server_major})." >&2
  exit 1
fi

psql "$DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 \
  -c "SET default_transaction_read_only = on" \
  -f "${here}/db-counts.sql" >"${out}/db-counts.tsv"

pg_dump "$DATABASE_URL" --format=custom --no-password \
  --schema=public --schema=auth --file="${out}/db.dump"

# The archive must be readable, and must contain what was counted.
pg_restore --list "${out}/db.dump" >"${out}/db.toc"
tables=$(wc -l <"${out}/db-counts.tsv")
data=$(grep -c ' TABLE DATA ' "${out}/db.toc" || true)
rm "${out}/db.toc"
if ((tables == 0 || data < tables)); then
  echo "::error::dump has ${data} table data entries for ${tables} tables." >&2
  exit 1
fi
echo "Dumped ${tables} tables ($(du -h "${out}/db.dump" | cut -f1)) to ${out}/db.dump"
