import { describe, expect, it } from "vitest";
import {
  RECRUITMENT_ROLES,
  RECRUITMENT_PURPOSE,
  RECRUITMENT_FORMAT,
  buildRecruitmentCopyPack,
  formatRecruitmentCopyPack,
  isRecruitmentRole,
  META_CTAS,
  ctaLabel,
} from "./recruitment";
import * as recruitment from "./recruitment";

describe("recruitment roles", () => {
  it("locks P0 to editor, smm and avatar", () => {
    expect(RECRUITMENT_ROLES).toEqual(["editor", "smm", "avatar"]);
    expect(isRecruitmentRole("editors")).toBe(false);
    expect(isRecruitmentRole("producer")).toBe(false);
    expect(isRecruitmentRole("editor")).toBe(true);
  });

  it("no longer ships canned briefs to pre-fill the form", () => {
    // Three hard-coded briefs meant every editor ad AA ran opened with the
    // same sentence, and they occupied exactly the space the operator's own
    // knowledge of the opening needed. Briefs are written per opening now.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((recruitment as any).RECRUITMENT_TEMPLATES).toBeUndefined();
  });
});

describe("purpose tag", () => {
  it("tags the lane recruitment, not a client campaign", () => {
    expect(RECRUITMENT_PURPOSE).toBe("recruitment");
    expect(RECRUITMENT_FORMAT).toBe("meta_static");
  });
});

describe("export pack shape", () => {
  const base = {
    role: "editor" as const,
    hook: "Brief headline",
    script: "Brief primary text",
    call_to_action: "Apply now",
    apply_url: "https://attractacq.com/careers/editor",
    compensation_text: "£250/day",
    asset: {
      id: "asset-1",
      ref_number: "AA-0042",
      storage_path: "house/aa-0042.png",
    },
  };

  it("exports image + primary text / headline / CTA + apply URL + optional comp", () => {
    const pack = buildRecruitmentCopyPack({
      ...base,
      concept: {
        headline: "Cut the work that actually ships",
        subhead: "On-brand stills, no stock filler",
        call_to_action: "Apply now",
      },
    });
    expect(pack).toEqual({
      purpose: "recruitment",
      role: "editor",
      format: "meta_static",
      headline: "Cut the work that actually ships",
      primary_text: "On-brand stills, no stock filler",
      cta: "Apply now",
      apply_url: "https://attractacq.com/careers/editor",
      compensation: "£250/day",
      image: {
        asset_id: "asset-1",
        ref_number: "AA-0042",
        storage_path: "house/aa-0042.png",
      },
    });
    expect(formatRecruitmentCopyPack(pack)).toContain("APPLY URL: https://attractacq.com/careers/editor");
    expect(formatRecruitmentCopyPack(pack)).toContain("COMPENSATION: £250/day");
  });

  it("omits compensation when the ad has none", () => {
    const pack = buildRecruitmentCopyPack({ ...base, compensation_text: "  " });
    expect(pack.compensation).toBeNull();
    expect(formatRecruitmentCopyPack(pack)).not.toContain("COMPENSATION:");
  });

  it("falls back to brief fields when the concept has not landed yet", () => {
    const pack = buildRecruitmentCopyPack({ ...base, concept: null });
    expect(pack.headline).toBe("Brief headline");
    expect(pack.primary_text).toBe("Brief primary text");
  });

  it("refuses a pack without an https apply URL", () => {
    expect(() =>
      buildRecruitmentCopyPack({ ...base, apply_url: "http://example.com/apply" }),
    ).toThrow(/https apply URL/);
  });

  it("refuses a pack for a role that is not in the P0 enum", () => {
    expect(() => buildRecruitmentCopyPack({ ...base, role: "producer" })).toThrow(/editor, smm or avatar/);
  });
});


// The generator was writing prose CTAs — "Apply with three cutdowns". Good
// copy, and unusable: Meta renders a button from its own fixed list, so
// whoever built the ad had to pick a real one and discard the words.
describe("the Meta call-to-action button", () => {
  it("offers only buttons that work on a link ad to an apply URL", () => {
    expect(META_CTAS.map((c) => c.value)).toEqual([
      "APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US",
    ]);
  });

  it("renders the label a person reads, not the API value", () => {
    expect(ctaLabel("APPLY_NOW")).toBe("Apply now");
    expect(ctaLabel("CONTACT_US")).toBe("Contact us");
  });

  it("still renders briefs written before the CTA was a fixed value", () => {
    // One production brief holds the prose "Apply now". It must keep showing.
    expect(ctaLabel("Apply now")).toBe("Apply now");
    expect(ctaLabel("Apply with three cutdowns")).toBe("Apply with three cutdowns");
    expect(ctaLabel(null)).toBe("");
  });
});

describe("the copy pack names the button", () => {
  const source = {
    role: "editor",
    hook: "Cut the work that ships",
    script: "You take an approved brief and finish it.",
    call_to_action: "APPLY_NOW",
    apply_url: "https://attractacq.com/careers/editor",
    compensation_text: null,
    asset: { id: "a1", ref_number: "AA-0029", storage_path: "house/ad.png" },
  };

  it("prints the label and the value, because the person setting up the ad needs both", () => {
    const text = formatRecruitmentCopyPack(buildRecruitmentCopyPack(source));
    expect(text).toContain("CTA BUTTON: Apply now (APPLY_NOW)");
  });

  it("takes the button from the brief, not the creative concept", () => {
    // Headline and primary text come from the concept, but the button is an
    // ad-level setting — the image copy has no say in it.
    const text = formatRecruitmentCopyPack(
      buildRecruitmentCopyPack({
        ...source,
        concept: { headline: "A better headline", call_to_action: "Swipe up now" },
      }),
    );
    expect(text).toContain("CTA BUTTON: Apply now (APPLY_NOW)");
    expect(text).not.toContain("Swipe up now");
    expect(text).toContain("A better headline");
  });
});
