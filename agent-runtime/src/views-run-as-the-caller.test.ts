import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Every view in the schema runs as the caller.
 *
 * A Postgres view runs as its *owner* unless it says otherwise. The owner is
 * the migration role, which is not subject to row level security, so a view
 * over an RLS-protected table quietly hands every row to anyone who may
 * select from the view. The RLS on the table underneath is simply not
 * consulted. Nothing fails; the data just comes out.
 *
 * That is how post_copy_effective (migration 145) shipped to production
 * exposing every client's captions, and how distribution_due (122) had been
 * exposing every client's scheduled posts since it was written. Both are
 * fixed in 148. Neither was caught by review, twice, because the defect is
 * the absence of a clause rather than the presence of a wrong one.
 *
 * So it is checked mechanically instead. This reads the migrations rather
 * than a database, because the migrations are what will be applied to the
 * next environment, and because it has to run in CI where there is no
 * database to ask.
 */

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/** `create [or replace] view <name> [with (...)] as` */
const CREATE_VIEW = /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?("?[a-z_][a-z0-9_]*"?)([\s\S]*?)\bas\b/gi;
/** `alter view <name> set (security_invoker = true)` */
const ALTER_VIEW = /alter\s+view\s+(?:public\.)?("?[a-z_][a-z0-9_]*"?)\s+set\s*\(([^)]*)\)/gi;

const unquote = (name: string) => name.replace(/"/g, "");
const setsInvoker = (clause: string) => /security_invoker\s*=\s*(true|on)/i.test(clause);

/**
 * The last word on each view, in migration order.
 *
 * A view may be created without the setting and fixed by a later ALTER, or
 * replaced outright. Only the final state matters, so earlier migrations are
 * allowed to be wrong — they are history, and rewriting them would not change
 * what is running.
 */
async function finalState(): Promise<Map<string, boolean>> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const state = new Map<string, boolean>();
  for (const file of files) {
    const sql = await readFile(new URL(file, MIGRATIONS), "utf8");
    // Strip line comments so a view named in prose is not mistaken for one.
    const code = sql.replace(/^\s*--.*$/gm, "");
    for (const match of code.matchAll(CREATE_VIEW)) {
      state.set(unquote(match[1]!), setsInvoker(match[2] ?? ""));
    }
    for (const match of code.matchAll(ALTER_VIEW)) {
      if (setsInvoker(match[2] ?? "")) state.set(unquote(match[1]!), true);
    }
  }
  return state;
}

describe("every view runs as the caller", () => {
  it("finds the views at all, so a silent pass is not possible", async () => {
    const state = await finalState();
    // If the regexes stopped matching, every assertion below would pass by
    // finding nothing. This is the test that notices.
    expect(state.size).toBeGreaterThan(10);
    expect([...state.keys()]).toContain("distribution_due");
    expect([...state.keys()]).toContain("post_copy_effective");
  });

  it("leaves none of them running as the owner", async () => {
    const state = await finalState();
    const owner = [...state.entries()].filter(([, invoker]) => !invoker).map(([name]) => name);
    expect(
      owner,
      `These views run as their owner and will read past RLS:\n  ${owner.join("\n  ")}\n` +
        `Add "with (security_invoker = true)" to the view, or "alter view <name> set (security_invoker = true)".`,
    ).toEqual([]);
  });

  it("counts a later alter as the fix, not the original create", async () => {
    // distribution_due is created without it in 122 and fixed in 148. The
    // check has to read the end of the story rather than the beginning.
    const state = await finalState();
    expect(state.get("distribution_due")).toBe(true);
    expect(state.get("post_copy_effective")).toBe(true);
  });
});
