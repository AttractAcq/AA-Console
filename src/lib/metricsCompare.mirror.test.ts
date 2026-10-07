import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two copies of the period-over-period arithmetic say the same thing.
 *
 * They are two files because agent-runtime and the browser do not share a
 * tsconfig, not because they are allowed to differ. The totals have lived in
 * one place since migration 38 on the argument that a chart saying one thing
 * while the write-up says another is worse than having neither. A change that
 * drifts between them is worse still: a reader comparing a panel's "+25%" to
 * a write-up's "+30%" has no way to know which to believe, and both look
 * authoritative.
 *
 * `npm run sync:metrics-compare` is the fix when this fails.
 */
const MARK = "// ---- shared region: byte-identical with the mirror; a test enforces it ----";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the metrics comparison mirror", () => {
  it("is byte-identical with the runtime copy below the marker", () => {
    const source = read("../../agent-runtime/src/agents/reporting/compare-shared.ts");
    const mirror = read("./metricsCompare.ts");
    expect(source).toContain(MARK);
    expect(mirror).toContain(MARK);
    expect(mirror.slice(mirror.indexOf(MARK))).toBe(source.slice(source.indexOf(MARK)));
  });

  it("carries the thresholds the refusals depend on", () => {
    // A mirror that synced the functions and not the constants would read as
    // in sync and answer differently.
    const mirror = read("./metricsCompare.ts");
    expect(mirror).toContain("MIN_BASE_FOR_PERCENT = 20");
    expect(mirror).toContain("MAX_COVERAGE_GAP = 0.2");
  });
});
