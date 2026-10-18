import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Every gate the migrations define is one the exposure view can see.
 *
 * This pins a failure that happened rather than one that might. Migration
 * 161 added `security_definer_exposure`, whose `body_checks_the_caller`
 * column decides whether a SECURITY DEFINER function checks its own caller
 * by looking for the names of this codebase's gates. 161 taught it
 * `may_advance_slot`. Then 166 introduced `may_touch_assignment` and nobody
 * went back, so six gated functions on production read as "relying entirely
 * on their grants" — and six false positives in a list of twenty teaches
 * whoever reads it that rows are noise.
 *
 * A source test rather than a database one on purpose: the gates are spread
 * across migrations that no single test harness replays together, and what
 * needs checking is the repo's own consistency, not any one database's.
 */
const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

async function allMigrationSql(): Promise<string> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const bodies = await Promise.all(
    files.map((f) => readFile(new URL(f, MIGRATIONS), "utf8")),
  );
  return bodies.join("\n");
}

/** The regex literal 168 builds, as the database would return it. */
function gateMarkers(sql: string): string {
  const fn = sql.slice(sql.indexOf("function public.caller_gate_markers()"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  return body;
}

describe("the gates the exposure view knows about", () => {
  it("includes every may_* predicate the migrations define", async () => {
    const sql = await allMigrationSql();
    const defined = [
      ...new Set([...sql.matchAll(/create or replace function public\.(may_\w+)/g)].map((m) => m[1]!)),
    ].sort();

    // If this is empty the test is measuring nothing.
    expect(defined.length).toBeGreaterThan(0);

    const markers = gateMarkers(sql);
    for (const gate of defined) {
      expect(markers, `${gate} is a gate the exposure view cannot see`).toContain(gate);
    }
  });

  it("includes the two functions that gate on the caller themselves", async () => {
    // advance_slot and advance_assignment both refuse a caller who cannot
    // reach the client, so calling either is a gate. The wrappers around
    // them — accept_assignment and the rest — rely on exactly this.
    const markers = gateMarkers(await allMigrationSql());
    expect(markers).toContain("advance_slot");
    expect(markers).toContain("advance_assignment");
  });

  it("includes the MCP's own equivalent", async () => {
    const markers = gateMarkers(await allMigrationSql());
    expect(markers).toContain("require_active_bot");
    expect(markers).toContain("require_bot_client_grant");
  });

  it("says in the function's own comment that it must be extended", async () => {
    // The mechanism is a person remembering, so the reminder lives next to
    // the thing they have to remember.
    const sql = await allMigrationSql();
    expect(sql).toMatch(/Extend it when you add a new gate/);
  });
});
