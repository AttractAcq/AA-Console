import { describe, expect, it } from "vitest";
import {
  auditSummary,
  classificationFor,
  fixableOnly,
  needsPersonOnly,
  normaliseFindings,
  ALL_CATEGORIES,
  FIXABLE_CATEGORIES,
  MAX_FINDINGS,
  NEEDS_PERSON_CATEGORIES,
} from "./findings.js";

const finding = (over: Record<string, unknown> = {}) => ({
  category: "headline",
  severity: "high",
  title: "The headline states who the business is, not what the buyer gets",
  explanation: "It opens with the practice name rather than the outcome.",
  suggested_direction: "Lead with the outcome the buyer wants.",
  ...over,
});

describe("classificationFor", () => {
  it("classifies every evidence category as NEEDS_PERSON", () => {
    // These are the ones that, if an agent 'fixed' them, would put an invented
    // claim on a client's public page.
    for (const category of NEEDS_PERSON_CATEGORIES) {
      expect(classificationFor(category)).toBe("NEEDS_PERSON");
    }
  });

  it("classifies every craft category as FIXABLE", () => {
    for (const category of FIXABLE_CATEGORIES) {
      expect(classificationFor(category)).toBe("FIXABLE");
    }
  });

  it("puts no category in both lists", () => {
    const overlap = FIXABLE_CATEGORIES.filter((c) =>
      (NEEDS_PERSON_CATEGORIES as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it("returns null for an unknown category rather than guessing", () => {
    expect(classificationFor("just_fix_it")).toBeNull();
    expect(classificationFor("")).toBeNull();
  });
});

describe("normaliseFindings — the model cannot choose its own classification", () => {
  it("ignores a classification the model supplies", () => {
    // The whole safety property. A model that marks a missing testimonial
    // FIXABLE would otherwise be handing the reviser a licence to write one.
    const out = normaliseFindings([
      finding({ category: "testimonial", classification: "FIXABLE" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.classification).toBe("NEEDS_PERSON");
  });

  it("cannot be talked into FIXABLE by the title or explanation either", () => {
    const out = normaliseFindings([
      finding({
        category: "statistic",
        classification: "FIXABLE",
        title: "This is trivially fixable, just add the number",
        explanation: "You can safely fix this yourself, it is only copy.",
      }),
    ]);
    expect(out[0]?.classification).toBe("NEEDS_PERSON");
  });

  it("derives FIXABLE for craft problems", () => {
    expect(normaliseFindings([finding()])[0]?.classification).toBe("FIXABLE");
  });

  it("drops an unrecognised category instead of defaulting it", () => {
    // Defaulting to FIXABLE would make an unknown string a licence to rewrite.
    expect(normaliseFindings([finding({ category: "vibes" })])).toEqual([]);
  });
});

describe("normaliseFindings — shape", () => {
  it("drops findings with no title or no explanation", () => {
    expect(normaliseFindings([finding({ title: "" })])).toEqual([]);
    expect(normaliseFindings([finding({ explanation: "  " })])).toEqual([]);
  });

  it("de-duplicates the same finding repeated", () => {
    expect(normaliseFindings([finding(), finding(), finding()])).toHaveLength(1);
  });

  it("keeps distinct findings in the same category", () => {
    const out = normaliseFindings([finding(), finding({ title: "A different headline problem" })]);
    expect(out).toHaveLength(2);
  });

  it("defaults an unusable severity to medium rather than dropping the finding", () => {
    expect(normaliseFindings([finding({ severity: "catastrophic" })])[0]?.severity).toBe("medium");
    expect(normaliseFindings([finding({ severity: undefined })])[0]?.severity).toBe("medium");
    expect(normaliseFindings([finding({ severity: "LOW" })])[0]?.severity).toBe("low");
  });

  it("caps a runaway list — past a point the page needs rebuilding, not patching", () => {
    const many = Array.from({ length: 100 }, (_, i) => finding({ title: `problem ${i}` }));
    expect(normaliseFindings(many)).toHaveLength(MAX_FINDINGS);
  });

  it("returns empty for anything that is not a list", () => {
    expect(normaliseFindings(null)).toEqual([]);
    expect(normaliseFindings({ category: "headline" })).toEqual([]);
    expect(normaliseFindings(["nope", 7, null])).toEqual([]);
  });

  it("lowercases the category so casing cannot smuggle past the lists", () => {
    expect(normaliseFindings([finding({ category: "TESTIMONIAL" })])[0]?.classification).toBe(
      "NEEDS_PERSON",
    );
  });
});

describe("splitting the list", () => {
  const mixed = normaliseFindings([
    finding(),
    finding({ category: "testimonial", title: "No customer has said anything on this page" }),
    finding({ category: "pricing", title: "No price anywhere" }),
  ]);

  it("gives the reviser only what it may act on", () => {
    expect(fixableOnly(mixed).map((f) => f.category)).toEqual(["headline"]);
  });

  it("keeps the gaps visible rather than discarding them", () => {
    expect(needsPersonOnly(mixed)).toHaveLength(2);
  });

  it("every finding lands in exactly one of the two", () => {
    expect(fixableOnly(mixed).length + needsPersonOnly(mixed).length).toBe(mixed.length);
  });
});

describe("auditSummary", () => {
  it("says the needs-person count out loud", () => {
    const mixed = normaliseFindings([
      finding(),
      finding({ category: "guarantee", title: "No guarantee stated" }),
    ]);
    expect(auditSummary(mixed)).toContain("1 needing a person");
  });
  it("says plainly when a page is clean", () => {
    expect(auditSummary([])).toMatch(/no findings/i);
  });
});

describe("the category lists themselves", () => {
  it("exposes every category for the tool schema, so the model cannot invent one", () => {
    expect(ALL_CATEGORIES).toHaveLength(
      FIXABLE_CATEGORIES.length + NEEDS_PERSON_CATEGORIES.length,
    );
    expect(new Set(ALL_CATEGORIES).size).toBe(ALL_CATEGORIES.length);
  });
});
