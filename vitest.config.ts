import { defineConfig } from "vitest/config";

// agent-runtime is a separate deployable with its own package.json,
// dependency tree and NodeNext module setup — it owns and runs its own
// tests via its own `npm test`, not this one.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "agent-runtime/**"],
  },
});
