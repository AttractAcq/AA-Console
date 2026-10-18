import { defineConfig } from "vitest/config";

// Without a config file here, Vitest walks up to the repo-root
// vitest.config.ts, which then needs the root's own `vitest` package —
// not installed when CI runs `npm ci` scoped to this directory only.
export default defineConfig({
  test: {
    // The *.pg.test.ts suites each stand up a PGlite instance in beforeAll and
    // replay a dozen or more real migrations into it. That is genuinely slower
    // than the 10s default hook timeout, and because Vitest runs files in
    // parallel, several WASM Postgres instances compete for the same cores —
    // so which suite trips the limit varies run to run. Raising the ceiling
    // rather than lowering parallelism: the work is bounded, just not fast.
    hookTimeout: 60_000,
  },
});
