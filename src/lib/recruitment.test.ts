import { describe, expect, it } from "vitest";
import {
  RECRUITMENT_ROLES,
  RECRUITMENT_PURPOSE,
  RECRUITMENT_FORMAT,
  RECRUITMENT_TEMPLATES,
  buildRecruitmentCopyPack,
  formatRecruitmentCopyPack,
  isRecruitmentRole,
} from "./recruitment";

describe("recruitment roles", () => {
  it("locks P0 to editor, smm and avatar", () => {
    expect(RECRUITMENT_ROLES).toEqual(["editor", "smm", "avatar"]);
    expect(isRecruitmentRole("editors")).toBe(false);
    expect(isRecruitmentRole("producer")).toBe(false);
    expect(isRecruitmentRole("editor")).toBe(true);
  });

  it("has a Meta-static template for each role", () => {
    for (const role of RECRUITMENT_ROLES) {
      const t = RECRUITMENT_TEMPLATES[role];
      expect(t.role).toBe(role);
      expect(t.channel_intent).toBe("Meta static");
      expect(t.hook.length).toBeGreaterThan(0);
      expect(t.script.length).toBeGreaterThan(0);
      expect(t.call_to_action.length).toBeGreaterThan(0);
    }
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
