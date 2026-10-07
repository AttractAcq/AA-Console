import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the Instagram account endpoint is asked for.
 *
 * Every organic ingest on production failed on 6 October with that
 * endpoint's own answer:
 *
 *   (#100) metric[0] must be one of the following values: reach,
 *   follower_count, website_clicks, profile_views, online_followers,
 *   accounts_engaged, total_interactions, ...
 *
 * `metric[0]` was `views`. The media endpoint accepts it and the account
 * endpoint does not, and asking for it failed the whole call — so reach and
 * interactions were lost along with it. A source test rather than a mocked
 * fetch, because what is being pinned is the constant, and a fetch mock
 * would happily accept any string.
 */
const source = readFileSync(new URL("./graph.ts", import.meta.url), "utf8");

const constant = (name: string): string => {
  const match = source.match(new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`));
  if (!match) throw new Error(`${name} is not a single string literal any more`);
  return match[1]!;
};

/** Exactly what the account endpoint listed as acceptable, in its error. */
const ACCEPTED = [
  "reach",
  "follower_count",
  "website_clicks",
  "profile_views",
  "online_followers",
  "accounts_engaged",
  "total_interactions",
];

describe("account insights, period=day", () => {
  it("asks only for metrics that endpoint accepts", () => {
    for (const metric of constant("ACCOUNT_METRICS").split(",")) {
      expect(ACCEPTED, `"${metric}" is not in the list the API gave`).toContain(metric.trim());
    }
  });

  it("does not ask for views, which is the one that failed", () => {
    // Named rather than left to the list above: this is the regression.
    expect(constant("ACCOUNT_METRICS").split(",").map((m) => m.trim())).not.toContain("views");
  });

  it("still asks for the two that carry the reporting panels", () => {
    const metrics = constant("ACCOUNT_METRICS").split(",").map((m) => m.trim());
    expect(metrics).toContain("reach");
    expect(metrics).toContain("total_interactions");
  });

  it("still asks the media endpoint for views, which it does accept", () => {
    // The two endpoints genuinely differ, and conflating them is how this
    // broke. Dropping views from the media call would lose per-post reach
    // reporting entirely.
    expect(source).toMatch(/IG_MEDIA_FIELDS[\s\S]{0,200}insights\.metric\([^)]*views/);
  });
});
