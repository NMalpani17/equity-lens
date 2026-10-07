/**
 * Integration tests against a real, THROWAWAY Postgres (CI's service container
 * or a local Docker one): Prisma runs its real queries, so raw SQL, advisory
 * locks and transactions are exercised. Never production: api/.env points at
 * production, so the URL comes only from API_TEST_DATABASE_URL and must be on
 * localhost. Without it every test is skipped.
 *
 *   API_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/api_integration \
 *     npm run test:integration
 */
import { defineConfig } from "vitest/config";

const url = process.env.API_TEST_DATABASE_URL ?? "";
if (url && !/^postgres(ql)?:\/\/[^@/]*@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  throw new Error("API_TEST_DATABASE_URL must point at a local (throwaway) database");
}
// CI sets this so the tests can never pass by being skipped.
if (!url && process.env.REQUIRE_INTEGRATION_DB) {
  throw new Error("API_TEST_DATABASE_URL is required (REQUIRE_INTEGRATION_DB is set)");
}
// Never empty: config.ts validates these before any test can skip.
const databaseUrl = url || "postgresql://none:none@127.0.0.1:1/none";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // One database, shared state: run files one at a time.
    fileParallelism: false,
    env: {
      API_TEST_DATABASE_URL: url,
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      SUPABASE_URL: "https://project-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      AI_SERVICE_INTERNAL_TOKEN: "test-internal-token",
    },
  },
});
