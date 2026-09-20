import { describe, expect, it } from "vitest";
import {
  MAX_PILLARS,
  MIN_PILLARS,
  pillarSetProblem,
  shareHint,
  totalShare,
  type ContentPillar,
} from "./contentPillars";

const pillar = (over: Partial<ContentPillar> = {}): ContentPillar => ({
  id: "p1",
  slug: "honest-proof",
  name: "Honest proof",
  premise: "Proof beats volume.",
  belongs: "Named results with a source.",
  does_not_belong: "Unattributed claims.",
  target_share: 25,
  active: true,
  ...over,
});

const four = (): ContentPillar[] =>
  [1, 2, 3, 4].map((n) => pillar({ id: `p${n}`, slug: `p${n}`, name: `P${n}`, target_share: 25 }));

describe("totalShare", () => {
  it("adds the shares", () => {
    expect(totalShare(four())).toBe(100);
  });

  it("treats a non-number as zero rather than NaN", () => {
    expect(totalShare([{ target_share: Number.NaN }, { target_share: 40 }])).toBe(40);
  });
});

describe("pillarSetProblem", () => {
  it("accepts a set of four totalling 100", () => {
    expect(pillarSetProblem(four())).toBeNull();
  });

  it("ignores retired pillars entirely", () => {
    const set = [...four(), pillar({ id: "old", slug: "old", name: "Retired", active: false, target_share: 80 })];
    expect(pillarSetProblem(set)).toBeNull();
  });

  it("refuses a set that is too small or too large", () => {
    expect(pillarSetProblem(four().slice(0, 2))).toContain(`at least ${MIN_PILLARS}`);
    const seven = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      pillar({ id: `p${n}`, slug: `p${n}`, name: `P${n}`, target_share: 14 }),
    );
    expect(pillarSetProblem(seven)).toContain(`at most ${MAX_PILLARS}`);
  });

  it("refuses shares that do not split a calendar", () => {
    const set = four();
    set[0]!.target_share = 60;
    expect(pillarSetProblem(set)).toContain("135%");
  });

  it("accepts the rounding a five-way split forces", () => {
    const five = [20, 20, 20, 20, 19].map((s, i) =>
      pillar({ id: `p${i}`, slug: `p${i}`, name: `P${i}`, target_share: s }),
    );
    expect(pillarSetProblem(five)).toBeNull();
  });

  it("refuses a pillar with no boundary", () => {
    const set = four();
    set[1]!.does_not_belong = "  ";
    expect(pillarSetProblem(set)).toContain("absorbs everything");
  });

  it("refuses a pillar missing its premise or inclusion", () => {
    const a = four();
    a[0]!.premise = "";
    expect(pillarSetProblem(a)).toContain("no premise");
    const b = four();
    b[0]!.belongs = "";
    expect(pillarSetProblem(b)).toContain("what belongs");
  });
});

describe("shareHint", () => {
  it("says so when the split is clean", () => {
    expect(shareHint(four())).toBe("Shares total 100%.");
  });

  it("names the gap in either direction", () => {
    const under = four();
    under[0]!.target_share = 10;
    expect(shareHint(under)).toBe("Shares total 85% — under by 15.");
    const over = four();
    over[0]!.target_share = 40;
    expect(shareHint(over)).toBe("Shares total 115% — over by 15.");
  });
});
