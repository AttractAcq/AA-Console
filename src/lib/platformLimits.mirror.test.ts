import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two copies of the platform limits say the same thing.
 *
 * They are two files because agent-runtime and the browser do not share a
 * tsconfig, not because they are allowed to differ. A limit that drifts
 * between them is the worst kind of bug here: a caption the form accepts and
 * the publisher later refuses, or the reverse, with nothing failing in between.
 *
 * `npm run sync:platform-limits` is the fix when this fails.
 */
const MARK = "// ---- shared region: byte-identical with the mirror; a test enforces it ----";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the platform limits mirror", () => {
  it("is byte-identical with the runtime copy below the marker", () => {
    const source = read("../../agent-runtime/src/content/platform-limits.ts");
    const mirror = read("./platformLimits.ts");
    expect(source).toContain(MARK);
    expect(mirror).toContain(MARK);
    expect(mirror.slice(mirror.indexOf(MARK))).toBe(source.slice(source.indexOf(MARK)));
  });
});
