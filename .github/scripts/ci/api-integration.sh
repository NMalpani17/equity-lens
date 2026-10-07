#!/usr/bin/env bash
# Usage: PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#          .github/scripts/ci/api-integration.sh
#
# The api's integration tests (api/tests/integration) against a THROWAWAY
# local Postgres: creates the api_integration database, applies every Prisma
# migration, runs the tests with real queries, then drops it.
#
# Run from the repo root after `npm ci` in api/.
set -euo pipefail
: "${PG_ADMIN_URL:?set PG_ADMIN_URL to a local Postgres admin connection string}"
repo=$(pwd)

if [[ ! $PG_ADMIN_URL =~ ^postgres(ql)?://[^@/]*@(localhost|127\.0\.0\.1)[:/] ]]; then
  echo "error: PG_ADMIN_URL must point at localhost; this script drops a database" >&2
  exit 2
fi
url="${PG_ADMIN_URL%/*}/api_integration"
url="${url/@localhost/@127.0.0.1}"

psql "$PG_ADMIN_URL" -Xq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS api_integration" -c "CREATE DATABASE api_integration"

# Prisma runs from a copy of api/prisma, away from any api/.env (whose URLs
# point at production), with both URLs set explicitly.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r "${repo}/api/prisma" "${work}/prisma"
(cd "$work" && DATABASE_URL="$url" DIRECT_URL="$url" \
  "${repo}/api/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)

# REQUIRE_INTEGRATION_DB makes a missing URL an error instead of a skip.
(cd "${repo}/api" && API_TEST_DATABASE_URL="$url" REQUIRE_INTEGRATION_DB=1 \
  npm run test:integration)

psql "$PG_ADMIN_URL" -Xq -c "DROP DATABASE api_integration"
echo "api integration tests passed."
