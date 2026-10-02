import path from "node:path";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Pin the time zone for the whole run so date/time output is the same on a
// laptop and in CI (which runs in UTC). Set before workers start, so every
// test process inherits it; tests that need another zone pass one explicitly.
const TEST_TIME_ZONE = "America/New_York";
process.env.TZ = TEST_TIME_ZONE;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    // Placeholder Supabase config so the client can be constructed in tests.
    // Auth-flow tests mock the Supabase module entirely.
    env: {
      VITE_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    },
  },
});
