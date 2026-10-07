-- Exact row count of every table in the backed-up schemas, one
-- "schema.table<TAB>count" line each (run with psql -XAt -F <TAB>).
-- backup-db.sh records these next to the dump; restore-db.sh compares them.
SELECT format(
    'SELECT %L, count(*) FROM %I.%I',
    schemaname || '.' || tablename, schemaname, tablename
)
FROM pg_tables
WHERE schemaname IN ('public', 'auth')
ORDER BY schemaname, tablename
\gexec
