import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Placeholder connection strings so config validation passes in tests.
    // Tests mock the Prisma client, so no real database is contacted.
    env: {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/equitylens_test",
      DIRECT_URL: "postgresql://user:pass@localhost:5432/equitylens_test",
    },
  },
});
