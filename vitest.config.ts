import { defineConfig } from "vitest/config";

// agent-runtime is a separate deployable with its own package.json,
// dependency tree and NodeNext module setup — it owns and runs its own
// tests via its own `npm test`, not this one.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "agent-runtime/**"],
    // Component tests need a DOM. The pure-logic suites do not care, and
    // jsdom is cheap enough that splitting the run by environment would
    // cost more in config than it saves in milliseconds.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Panels read import.meta.env at module load through lib/supabase.
    // Without these the client constructor throws before a test can mock it.
    //
    // The key must be PUBLISHABLE_KEY — the name lib/supabase actually reads.
    // A wrong name here passes locally, because .env.local supplies the real
    // one, and fails only in a clean checkout: CI caught it, not the machine
    // that wrote it. That is the whole argument for running tests in CI.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    },
  },
});
