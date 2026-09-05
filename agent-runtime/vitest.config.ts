import { defineConfig } from "vitest/config";

// Without a config file here, Vitest walks up to the repo-root
// vitest.config.ts, which then needs the root's own `vitest` package —
// not installed when CI runs `npm ci` scoped to this directory only.
export default defineConfig({
  test: {},
});
