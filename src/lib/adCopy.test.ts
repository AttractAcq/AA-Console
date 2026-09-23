import { describe, expect, it } from "vitest";
import { adCopyProblems, clip, draftAdCopy, mergeCopy, toColumns, type AdCopy } from "./adCopy";

const brief = {
  title: "Open day at Greenfield: see the classrooms for yourself",
  hook: "Most parents choose a school from a brochure.",
  premise: "Come and walk the  corridors instead.",
  argument: "Unused because the premise is there.",
  call_to_action: "Sign up",
};

describe("draftAdCopy", () => {
  it("drafts from the brief's hook, premise, title and call to action", () => {
    expect(draftAdCopy({ brief, landingUrl: "https://greenfield.example/open-day", allowedCtas: ["SIGN_UP"] })).toEqual({
      ad_primary_text: "Most parents choose a school from a brochure.\n\nCome and walk the corridors instead.",
      ad_headline: "Open day at Greenfield: see the",
      ad_description: "",
      ad_link_url: "https://greenfield.example/open-day",
      ad_cta: "SIGN_UP",
    });
  });

  it("falls back to the template's first button when the brief's is prose Meta does not have", () => {
    const copy = draftAdCopy({ brief: { ...brief, call_to_action: "Book your visit" }, landingUrl: null, allowedCtas: ["BOOK_NOW", "LEARN_MORE"] });
    expect(copy.ad_cta).toBe("BOOK_NOW");
    expect(copy.ad_link_url).toBe("");
  });

  it("uses the argument when there is no premise, and the hook when there is no title", () => {
    const copy = draftAdCopy({ brief: { hook: "Short hook", argument: "The case." }, landingUrl: null, allowedCtas: [] });
    expect(copy.ad_primary_text).toBe("Short hook\n\nThe case.");
    expect(copy.ad_headline).toBe("Short hook");
    expect(copy.ad_cta).toBe("");
  });

  it("drafts something empty rather than failing when there is no brief", () => {
    expect(draftAdCopy({ brief: null, landingUrl: null, allowedCtas: [] }).ad_primary_text).toBe("");
  });
});

describe("clip", () => {
  it("cuts at a word boundary and drops trailing punctuation", () => {
    expect(clip("One two three, four", 14)).toBe("One two three");
    expect(clip("short", 40)).toBe("short");
  });
});

describe("mergeCopy", () => {
  it("keeps what a person saved and drafts only the blanks", () => {
    const draft = draftAdCopy({ brief, landingUrl: "https://x.example", allowedCtas: ["SIGN_UP"] });
    const merged = mergeCopy({ ad_headline: "Their headline", ad_link_url: "  " }, draft);
    expect(merged.ad_headline).toBe("Their headline");
    expect(merged.ad_link_url).toBe("https://x.example");
  });
});

describe("adCopyProblems", () => {
  const good: AdCopy = {
    ad_primary_text: "Words",
    ad_headline: "Headline",
    ad_description: "",
    ad_link_url: "https://example.com",
    ad_cta: "SIGN_UP",
  };

  it("passes complete copy", () => {
    expect(adCopyProblems(good, ["SIGN_UP"])).toEqual([]);
  });

  it("names every missing piece", () => {
    expect(adCopyProblems({ ...good, ad_primary_text: " ", ad_headline: "", ad_link_url: "" }, [])).toHaveLength(3);
  });

  it("refuses a link that is not https", () => {
    expect(adCopyProblems({ ...good, ad_link_url: "example.com" }, [])).toEqual([
      expect.stringMatching(/https/),
    ]);
  });

  it("refuses a button the template cannot serve", () => {
    expect(adCopyProblems({ ...good, ad_cta: "SEND_MESSAGE" }, ["SIGN_UP"])).toEqual([
      "This campaign's template allows: SIGN_UP.",
    ]);
  });
});

describe("toColumns", () => {
  it("stores blanks as null", () => {
    expect(toColumns({ ad_primary_text: " x ", ad_headline: "", ad_description: " ", ad_link_url: "https://a.b", ad_cta: "" })).toEqual({
      ad_primary_text: "x",
      ad_headline: null,
      ad_description: null,
      ad_link_url: "https://a.b",
      ad_cta: null,
    });
  });
});
