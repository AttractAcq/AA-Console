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
    // The same reasoning, for the suites that stand their PGlite up inside
    // the test rather than in a hook. Those were living on the 5s default
    // and passing at 1.9s in isolation, which is a pass with no margin: add
    // one more WASM Postgres to the pool and whichever file loses the race
    // for a core fails on the clock while asserting nothing. Raising the
    // ceiling rather than lowering parallelism, because the work is bounded
    // and the alternative is a slower suite that still flakes.
    testTimeout: 60_000,
  },
});
