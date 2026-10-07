-- Enable row level security on every table in this schema (public in
-- production), including _prisma_migrations.
--
-- Supabase's Data API serves the public schema to anyone holding the
-- publishable key, which ships in the browser bundle. With RLS on and no
-- policies, the anon and authenticated roles can never read or write a row,
-- even if table grants are restored. Only the api and ai-service connect, as
-- the tables' owner (postgres), which bypasses RLS (no FORCE), so the app is
-- unaffected.
--
-- Every later migration that creates a table must enable RLS on it too
-- (enforced by api/tests/repoPolicy.test.ts).
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END
$$;
