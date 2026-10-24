import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Every trigger function this repo creates has a fixed search_path.
 *
 * Three migrations have now fixed this one function at a time — 224 for one
 * of 218's guards, 233 for the one 230 inherited by copying that same
 * pattern, 234 for the nine that were left. Each time the finding arrived
 * from Supabase's linter days after the migration was applied, and each time
 * the fix was one line. The pattern worth breaking is not the missing path;
 * it is finding out late.
 *
 * So this is a source test, in the style of caller-gates.test.ts and for the
 * same stated reason: these functions are spread across migrations that no
 * single harness replays together, and what needs checking is the repo's own
 * consistency rather than any one database's state.
 *
 * It catches the next one at the moment it is written. A trigger function
 * either carries `set search_path` in its own definition or is pinned by a
 * later `alter function ... set search_path`; anything else fails here.
 *
 * Trigger functions only, deliberately. A regular function with a mutable
 * path is a finding too, but it is a different conversation: those are
 * called over REST by a caller whose path is not the one here, and this
 * database has 169 definer functions whose exposure has been reasoned about
 * as a pattern. Widening this test to all of them would make it a list of
 * decisions already taken rather than a guard against new mistakes.
 */

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/** One `create function` body, from the keyword to the `as $$`. */
interface Definition {
  readonly name: string;
  readonly file: string;
  /** The header text, where `set search_path` would appear if it does. */
  readonly header: string;
}

async function allMigrations(): Promise<{ file: string; sql: string }[]> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (file) => ({ file, sql: await readFile(new URL(file, MIGRATIONS), "utf8") })),
  );
}

/**
 * Trigger function definitions, by the one thing that identifies them:
 * `returns trigger`. Taken from the text between the create keyword and the
 * body delimiter, which is where every option — language, security, search
 * path — has to be written.
 */
function triggerDefinitions(file: string, sql: string): Definition[] {
  const out: Definition[] = [];
  const create = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi;
  for (const match of sql.matchAll(create)) {
    const name = match[1]!;
    const from = match.index!;
    // The header ends at the body. Dollar quoting is what every function in
    // this repo uses, and the tag varies ($$, $g$), so stop at the first one.
    const body = sql.slice(from).search(/\$[a-z_]*\$/i);
    const header = body === -1 ? sql.slice(from, from + 600) : sql.slice(from, from + body);
    if (!/returns\s+trigger/i.test(header)) continue;
    out.push({ name, file, header });
  }
  return out;
}

const HAS_PATH = /set\s+search_path\s*(?:=|to)/i;

describe("trigger functions and their search_path", () => {
  it("has no trigger function left unpinned anywhere in the migrations", async () => {
    const migrations = await allMigrations();
    expect(migrations.length).toBeGreaterThan(200); // the test is measuring something

    // Pinned after the fact: 224, 233 and 234 all use `alter function` rather
    // than a recreate, so the path lives in a different file from the body.
    const pinnedLater = new Set<string>();
    for (const { sql } of migrations) {
      for (const match of sql.matchAll(
        /alter\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s*set\s+search_path/gi,
      )) {
        pinnedLater.add(match[1]!);
      }
    }

    // A later definition wins, so the last one of each name decides.
    const latest = new Map<string, Definition>();
    for (const { file, sql } of migrations) {
      for (const definition of triggerDefinitions(file, sql)) {
        latest.set(definition.name, definition);
      }
    }
    expect(latest.size).toBeGreaterThan(20);

    const unpinned = [...latest.values()]
      .filter((d) => !HAS_PATH.test(d.header) && !pinnedLater.has(d.name))
      .map((d) => `${d.name} (${d.file})`)
      .sort();

    expect(
      unpinned,
      `These trigger functions have a mutable search_path. Add \`set search_path = pg_catalog, public\` to the definition, or pin it with \`alter function\` the way 234 does:\n  ${unpinned.join("\n  ")}`,
    ).toEqual([]);
  });

  it("recognises both ways a path gets fixed", async () => {
    // Guards against the test passing because its own parsing broke: one
    // function known to carry the path in its definition, one known to have
    // been pinned afterwards by 234.
    const migrations = await allMigrations();
    const inDefinition = migrations
      .flatMap(({ file, sql }) => triggerDefinitions(file, sql))
      .find((d) => d.name === "guard_proof_placement_status");
    expect(inDefinition, "218's status guard should be found as a trigger function").toBeTruthy();
    expect(HAS_PATH.test(inDefinition!.header)).toBe(true);

    const pinner = migrations.find((m) => m.file.includes("234_every_remaining_guard"))!;
    expect(pinner.sql).toMatch(
      /alter function public\.guard_campaign_manifest_immutable\(\)\s*set search_path/,
    );
  });
});
