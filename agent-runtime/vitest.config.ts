import { defineConfig } from "vitest/config";

// Without a config file here, Vitest walks up to the repo-root
// vitest.config.ts, which then needs the root's own `vitest` package —
// not installed when CI runs `npm ci` scoped to this directory only.
export default defineConfig({
  test: {
    // The *.pg.test.ts suites each stand up a PGlite instance in beforeAll and
    // replay real migrations into it. Unbounded file parallelism can leave the
    // GitHub runtime job inside npm test for over an hour while the other CI
    // jobs finish. Two workers keep the database fixtures moving on a standard
    // runner without starting a large pool of competing WASM databases.
    maxWorkers: 2,
    hookTimeout: 60_000,
    // A fixture created inside a test needs the same headroom as a beforeAll
    // fixture while migrations and PGlite initialization are in progress.
    testTimeout: 60_000,
  },
});
