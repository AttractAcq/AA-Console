import { describe, expect, it } from "vitest";

import { figuresIn, isVertical, qaFindings, qaScore, qaSummary, type QaInput } from "./checks.js";

const base: QaInput = {
  platform: "instagram",
  format: "single",
  copy: { caption: "Five steps, one chain.", hashtags: ["#proof"], alt_text: "Cards in a row." },
  bannedPhrases: [],
  briefText: "The chain is five steps. Ask one question.",
  hasProof: true,
  asset: { width: 1080, height: 1080 },
};

const input = (over: Partial<QaInput> = {}): QaInput => ({ ...base, ...over });
const details = (i: QaInput) => qaFindings(i).map((f) => f.detail).join(" | ");

describe("copy that is fine", () => {
  it("has nothing to flag and scores 100", () => {
    expect(qaFindings(base)).toEqual([]);
    expect(qaScore([])).toBe(100);
    expect(qaSummary([])).toBe("Nothing to flag.");
  });
});

describe("brand", () => {
  it("blocks a phrase the brand does not say", () => {
    const f = qaFindings(
      input({ copy: { ...base.copy, caption: "We are world class." }, bannedPhrases: ["world class"] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ area: "brand", severity: "blocker" });
  });

  it("looks in the hashtags and the first comment too", () => {
    expect(
      details(input({ copy: { ...base.copy, first_comment: "Truly world class" }, bannedPhrases: ["world class"] })),
    ).toMatch(/world class/);
    expect(
      details(input({ copy: { ...base.copy, hashtags: ["#worldclass"] }, bannedPhrases: ["worldclass"] })),
    ).toMatch(/worldclass/);
  });
});

describe("claims", () => {
  it("blocks a figure the brief does not contain", () => {
    // The rule the editor already applies to captions, applied to everything
    // that goes out with the post.
    const f = qaFindings(input({ copy: { ...base.copy, caption: "We grew them 47% in a month." } }));
    expect(f.some((x) => x.area === "claims" && x.detail.includes("47"))).toBe(true);
  });

  it("allows a figure that is in the brief", () => {
    expect(qaFindings(input({ copy: { ...base.copy, caption: "Five steps." } }))).toEqual([]);
  });

  it("does not mistake a time, a year, an ordinal or a hashtag for a claim", () => {
    const f = qaFindings(
      input({
        copy: {
          ...base.copy,
          caption: "Live at 9:30 on the 2nd, back in 2024.",
          hashtags: ["#top10"],
        },
      }),
    );
    expect(f.filter((x) => x.area === "claims")).toEqual([]);
  });

  it("warns when the brief carries figures and there is no proof on file", () => {
    const f = qaFindings(input({ hasProof: false, briefText: "We lifted bookings 30% in a quarter." }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ area: "claims", severity: "warning" });
  });
});

describe("platform", () => {
  it("blocks copy that breaks the platform's own limits", () => {
    const f = qaFindings(input({ copy: { ...base.copy, caption: "x".repeat(2300) } }));
    expect(f.some((x) => x.area === "platform" && /2,200/.test(x.detail))).toBe(true);
  });

  it("blocks a reel or story that is not 9:16", () => {
    for (const format of ["reel", "story"]) {
      const f = qaFindings(input({ format, asset: { width: 1080, height: 1080 } }));
      expect(f.some((x) => x.detail.includes("9:16"))).toBe(true);
    }
  });

  it("does not require a single image to be vertical", () => {
    expect(qaFindings(input({ format: "single", asset: { width: 1080, height: 1080 } }))).toEqual([]);
  });

  it("accepts a 9:16 asset a pixel out", () => {
    expect(isVertical(1080, 1920)).toBe(true);
    expect(isVertical(1081, 1920)).toBe(true);
    expect(isVertical(1080, 1080)).toBe(false);
  });

  it("warns about a reel that has stopped being one", () => {
    const f = qaFindings(input({ format: "reel", asset: { width: 1080, height: 1920, durationSec: 120 } }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warning" });
  });

  it("says nothing about dimensions it was not given", () => {
    expect(qaFindings(input({ format: "reel", asset: null }))).toEqual([]);
  });
});

describe("risk", () => {
  it("blocks a claim that needs a person to agree to it", () => {
    for (const caption of [
      "This cures gum disease.",
      "Results guaranteed.",
      "Completely risk-free.",
      "A pain-free visit.",
      "Clinically proven.",
      "Double your revenue.",
      "Build passive income.",
      "The best dentist in town.",
    ]) {
      const f = qaFindings(input({ copy: { ...base.copy, caption }, briefText: caption }));
      expect(f.some((x) => x.area === "risk"), caption).toBe(true);
    }
  });

  it("does not fire on ordinary words", () => {
    // A checker that flags "help" or "better" flags everything, and a QA
    // step that always fires is one people wave through.
    for (const caption of [
      "We can help with that.",
      "A better way to brief.",
      "Our best work this year.",
      "One question to ask.",
    ]) {
      expect(qaFindings(input({ copy: { ...base.copy, caption }, briefText: caption })), caption).toEqual([]);
    }
  });
});

describe("the score", () => {
  it("costs more for a blocker than a warning", () => {
    const blocker = qaScore([{ area: "brand", severity: "blocker", detail: "x" }]);
    const warning = qaScore([{ area: "claims", severity: "warning", detail: "x" }]);
    expect(blocker).toBeLessThan(warning);
    expect(warning).toBeLessThan(100);
  });

  it("never goes below zero, however much is wrong", () => {
    const many = Array.from({ length: 20 }, () => ({ area: "brand" as const, severity: "blocker" as const, detail: "x" }));
    expect(qaScore(many)).toBe(0);
  });

  it("puts four blockers under any sane threshold", () => {
    const four = Array.from({ length: 4 }, () => ({ area: "brand" as const, severity: "blocker" as const, detail: "x" }));
    expect(qaScore(four)).toBe(0);
  });

  it("summarises in words", () => {
    expect(
      qaSummary([
        { area: "brand", severity: "blocker", detail: "x" },
        { area: "claims", severity: "warning", detail: "y" },
      ]),
    ).toBe("1 blocker and 1 warning.");
  });
});

describe("figuresIn", () => {
  it("finds the numbers that are claims and ignores the ones that are not", () => {
    expect(figuresIn("47% in 2024 at 9:30 on the 2nd #top10 and 12 clients")).toEqual(["47%", "12"]);
  });
});
