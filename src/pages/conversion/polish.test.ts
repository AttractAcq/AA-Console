import { describe, expect, it } from "vitest";
import {
  groupFindings,
  isSelectable,
  readinessLine,
  reviseBlocker,
  revisionSourceLabel,
  selectableIds,
  usableSelection,
  type Finding,
} from "./polish";

const f = (over: Partial<Finding> = {}): Finding => ({
  id: "f1", category: "headline", severity: "medium",
  title: "Weak headline", explanation: "why", suggested_direction: null,
  classification: "FIXABLE", status: "open", revision_number: 1, ...over,
});

describe("selectability", () => {
  it("never lets a NEEDS_PERSON finding be selected", () => {
    // The rule the whole design rests on. Enforced again in the reviser and by
    // the column constraint; this is just the button not being offered.
    expect(isSelectable(f({ classification: "NEEDS_PERSON" }))).toBe(false);
    expect(isSelectable(f({ classification: "NEEDS_PERSON", status: "selected" }))).toBe(false);
  });

  it("lets a live fixable finding be selected", () => {
    expect(isSelectable(f())).toBe(true);
    expect(isSelectable(f({ status: "selected" }))).toBe(true);
  });

  it("does not offer an applied, dismissed or stale finding", () => {
    for (const status of ["applied", "dismissed", "stale"] as const) {
      expect(isSelectable(f({ status }))).toBe(false);
    }
  });

  it("select-all picks up only what may be acted on", () => {
    const all = [
      f({ id: "a" }),
      f({ id: "b", classification: "NEEDS_PERSON" }),
      f({ id: "c", status: "stale" }),
      f({ id: "d", status: "applied" }),
    ];
    expect(selectableIds(all)).toEqual(["a"]);
  });
});

describe("groupFindings", () => {
  const all = [
    f({ id: "a", severity: "low" }),
    f({ id: "b", severity: "high" }),
    f({ id: "c", classification: "NEEDS_PERSON", category: "testimonial", severity: "high" }),
    f({ id: "d", status: "stale" }),
    f({ id: "e", status: "applied" }),
  ];
  const grouped = groupFindings(all);

  it("separates what an agent can fix from what needs a person", () => {
    expect(grouped.fixable.map((x) => x.id)).toEqual(["b", "a"]);
    expect(grouped.needsPerson.map((x) => x.id)).toEqual(["c"]);
  });

  it("orders worst first", () => {
    expect(grouped.fixable[0]?.severity).toBe("high");
  });

  it("keeps stale findings separate rather than hiding them", () => {
    // They were true of an earlier revision and may still be; nothing has checked.
    expect(grouped.stale.map((x) => x.id)).toEqual(["d"]);
  });

  it("drops findings that are already dealt with", () => {
    const ids = [...grouped.fixable, ...grouped.needsPerson, ...grouped.stale].map((x) => x.id);
    expect(ids).not.toContain("e");
  });
});

describe("reviseBlocker", () => {
  const findings = [f({ id: "a" }), f({ id: "b", classification: "NEEDS_PERSON" })];

  it("blocks when nothing usable is chosen", () => {
    expect(reviseBlocker([], findings)).toMatch(/choose at least one/i);
  });

  it("blocks when only a needs-person finding was somehow chosen", () => {
    expect(reviseBlocker(["b"], findings)).toMatch(/choose at least one/i);
  });

  it("clears when a fixable finding is chosen", () => {
    expect(reviseBlocker(["a"], findings)).toBeNull();
  });

  it("ignores a tick left over from a previous audit", () => {
    expect(reviseBlocker(["gone"], findings)).toMatch(/choose at least one/i);
  });
});

describe("usableSelection", () => {
  it("narrows a submitted set to what may actually be acted on", () => {
    const findings = [f({ id: "a" }), f({ id: "b", classification: "NEEDS_PERSON" })];
    expect(usableSelection(["a", "b", "ghost"], findings)).toEqual(["a"]);
  });
});

describe("readinessLine", () => {
  it("leads with the gaps, because those decide whether a page is ready", () => {
    const line = readinessLine(groupFindings([
      f({ id: "a" }),
      f({ id: "b", classification: "NEEDS_PERSON" }),
    ]));
    expect(line.indexOf("gap")).toBeLessThan(line.indexOf("reviser can fix"));
  });

  it("says so plainly when nothing is outstanding", () => {
    expect(readinessLine(groupFindings([]))).toMatch(/no outstanding/i);
  });

  it("does not call a page clean when only proof gaps remain", () => {
    const line = readinessLine(groupFindings([f({ classification: "NEEDS_PERSON" })]));
    expect(line).not.toMatch(/no outstanding/i);
    expect(line).toMatch(/needing a real fact/i);
  });
});

describe("revisionSourceLabel", () => {
  it("reads in plain English", () => {
    expect(revisionSourceLabel("initial_generation")).toBe("Original build");
    expect(revisionSourceLabel("revert")).toBe("Revert");
    expect(revisionSourceLabel("agent_revision")).toBe("Agent revision");
  });
});
