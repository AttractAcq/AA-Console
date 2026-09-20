import { describe, expect, it } from "vitest";
import {
  MAX_PILLARS,
  MIN_PILLARS,
  normalisePillars,
  pillarSetProblem,
  slugify,
  type Pillar,
} from "./draft.js";

const pillar = (over: Partial<Pillar> = {}): Pillar => ({
  slug: "honest-proof",
  name: "Honest proof",
  premise: "Proof beats volume.",
  belongs: "Named results with a source.",
  does_not_belong: "Unattributed claims and round numbers.",
  target_share: 25,
  ...over,
});

/** Four pillars whose shares total 100. */
const validSet = (): Pillar[] => [
  pillar({ slug: "honest-proof", name: "Honest proof", target_share: 25 }),
  pillar({ slug: "the-veneer-door", name: "The veneer door", target_share: 25 }),
  pillar({ slug: "continuity", name: "Continuity and certainty", target_share: 25 }),
  pillar({ slug: "total-price", name: "Total-price certainty", target_share: 25 }),
];

describe("slugify", () => {
  it("makes a stable key a rename cannot break", () => {
    expect(slugify("Honest proof")).toBe("honest-proof");
    expect(slugify("Dignity, not vanity — the full-arch register")).toBe(
      "dignity-not-vanity-the-full-arch-register",
    );
  });

  it("collapses the punctuation that made two runs look like two pillars", () => {
    // These are the real pair from production.
    expect(slugify("Continuity and certainty")).toBe(slugify("Continuity and Certainty"));
  });

  it("leaves no leading or trailing dashes", () => {
    expect(slugify("  —Proof—  ")).toBe("proof");
    expect(slugify("!!!")).toBe("");
  });
});

describe("normalisePillars", () => {
  it("returns nothing for anything that is not a list", () => {
    expect(normalisePillars(null)).toEqual([]);
    expect(normalisePillars("pillars")).toEqual([]);
    expect(normalisePillars({})).toEqual([]);
  });

  it("drops entries with no name, since a pillar is named or it is nothing", () => {
    expect(normalisePillars([{ name: "  " }, { premise: "x" }, null, 7])).toEqual([]);
  });

  it("trims and derives the slug", () => {
    const [p] = normalisePillars([{ name: "  Honest proof  ", premise: " Proof beats volume. " }]);
    expect(p!.name).toBe("Honest proof");
    expect(p!.slug).toBe("honest-proof");
    expect(p!.premise).toBe("Proof beats volume.");
  });

  it("keeps a colliding name rather than silently dropping it", () => {
    const out = normalisePillars([{ name: "Honest proof" }, { name: "Honest Proof" }]);
    expect(out).toHaveLength(2);
    expect(out[1]!.slug).toBe("honest-proof-2");
  });

  it("clamps a share into a percentage", () => {
    expect(normalisePillars([{ name: "a", target_share: -5 }])[0]!.target_share).toBe(0);
    expect(normalisePillars([{ name: "a", target_share: 250 }])[0]!.target_share).toBe(100);
    expect(normalisePillars([{ name: "a", target_share: "30" }])[0]!.target_share).toBe(30);
    expect(normalisePillars([{ name: "a", target_share: 24.6 }])[0]!.target_share).toBe(25);
  });
});

describe("pillarSetProblem", () => {
  it("accepts a set of four that adds to 100", () => {
    expect(pillarSetProblem(validSet())).toBeNull();
  });

  it("accepts the rounding a five-way split forces", () => {
    const five = [20, 20, 20, 20, 19].map((s, i) =>
      pillar({ slug: `p${i}`, name: `P${i}`, target_share: s }),
    );
    expect(pillarSetProblem(five)).toBeNull();
  });

  it("refuses a set too small to be a strategy", () => {
    expect(pillarSetProblem(validSet().slice(0, 2))).toContain(`at least ${MIN_PILLARS}`);
  });

  it("refuses a set that has become a list of labels", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      pillar({ slug: `p${i}`, name: `P${i}`, target_share: 14 }),
    );
    expect(pillarSetProblem(seven)).toContain(`at most ${MAX_PILLARS}`);
  });

  it("refuses shares that cannot split a calendar", () => {
    const set = validSet();
    set[0]!.target_share = 60;
    expect(pillarSetProblem(set)).toContain("add up to 135%");
  });

  it("refuses a pillar with no premise or no inclusion", () => {
    const a = validSet();
    a[1]!.premise = "";
    expect(pillarSetProblem(a)).toContain("no premise");
    const b = validSet();
    b[1]!.belongs = "";
    expect(pillarSetProblem(b)).toContain("does not say what belongs");
  });

  // The half people skip, and the half that decides where an idea lands.
  it("refuses a pillar with no boundary", () => {
    const set = validSet();
    set[2]!.does_not_belong = "";
    const problem = pillarSetProblem(set);
    expect(problem).toContain("what stays out of it");
    expect(problem).toContain("absorbs everything");
  });

  it("refuses the same pillar proposed twice under different punctuation", () => {
    const set = normalisePillars([
      { name: "Continuity and certainty", premise: "p", belongs: "b", does_not_belong: "d", target_share: 34 },
      { name: "Continuity and Certainty", premise: "p", belongs: "b", does_not_belong: "d", target_share: 33 },
      { name: "Honest proof", premise: "p", belongs: "b", does_not_belong: "d", target_share: 33 },
    ]);
    expect(pillarSetProblem(set)).toContain("the same pillar");
  });
});
