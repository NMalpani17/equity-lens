-- Extensions the schema needs, created before restoring a backup.
--
-- backup-db.sh dumps only the public and auth schemas, so extensions (which
-- Supabase keeps in the "extensions" schema) aren't in the dump, while public
-- objects refer to them (the trigram indexes use extensions.gin_trgm_ops).
-- As Supabase advises for a restore, enable them on the target first.
-- Idempotent: on Supabase, where they're already enabled, nothing changes.
--
-- Run by restore-db.sh, and by hand before a disaster-recovery restore into a
-- new Supabase project (docs/deployment.md#restore-the-database). Every
-- extension a migration creates must be listed here (api/tests/repoPolicy.test.ts).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
-- Company search (migration 20261019000000_add_market_symbols_and_earnings).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
