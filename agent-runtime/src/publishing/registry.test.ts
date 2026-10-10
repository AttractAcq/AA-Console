import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { adapterFor, supportedPlatforms } from "./registry.js";

const migration = () =>
  readFile(new URL("../../../supabase/migrations/20261006235000_160_publishing.sql", import.meta.url), "utf8");

describe("which adapter posts where", () => {
  it("has one for each platform it claims to support", () => {
    expect(adapterFor("instagram")?.provider).toBe("instagram");
    expect(adapterFor("facebook")?.provider).toBe("meta");
  });

  it("has none for a platform with no connector", () => {
    expect(adapterFor("linkedin")).toBeNull();
    expect(adapterFor("tiktok")).toBeNull();
    expect(adapterFor("youtube")).toBeNull();
  });

  it("agrees with platform_publishing about what is supported", async () => {
    // The two disagreeing means a post claimed and then immediately failed,
    // or a post that can go out and never is. Neither is visible without
    // this test, because each half looks correct on its own.
    const sql = await migration();
    const rows = [...sql.matchAll(/\('(facebook|instagram|tiktok|linkedin|youtube)',\s*'[a-z]+',\s*(true|false)/g)];
    expect(rows.length).toBe(5);

    const code = new Set(supportedPlatforms());
    for (const [, platform, supported] of rows) {
      expect(code.has(platform as never)).toBe(supported === "true");
    }
  });

  it("agrees with platform_publishing about which provider each uses", async () => {
    const sql = await migration();
    const rows = [...sql.matchAll(/\('(facebook|instagram)',\s*'([a-z]+)',\s*true/g)];
    expect(rows.length).toBe(2);
    for (const [, platform, provider] of rows) {
      expect(adapterFor(platform!)?.provider).toBe(provider);
    }
  });
});
