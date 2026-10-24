import { describe, expect, it } from "vitest";

import { deriveSheet, renderSheet, seedKeywordGroups, type SheetCampaign } from "./index.js";

/**
 * What the sheet says, and more importantly what it refuses to say.
 *
 * Turning a service name into a keyword plan and presenting it as research is
 * the most expensive kind of plausible output: somebody spends money against
 * it. So `keyword_research` is always in `missing`, every seeded group carries
 * a note saying it is a seed, and an incomplete campaign produces a sheet that
 * names each gap rather than one that reads complete.
 */

const campaign: SheetCampaign = {
  id: "camp-1",
  client_id: "client-1",
  name: "Winter garage push",
  objective: "Book surveys",
  audience: "Homeowners in PO1",
  daily_budget: 40,
  target_countries: ["Portsmouth", "Southsea"],
  conversion_event: "survey_booked",
  offer_version_id: "ver-3",
};

const context = {
  pillars: ["garage conversion", "damp proofing"],
  serviceName: "Garage conversion",
  promise: "Dry in four days",
  pageId: "page-1",
  pageUrl: "https://harbourhome.co.uk/garage-survey",
  approvedCopy: 3,
};

describe("what it will not invent", () => {
  it("always says keyword research has not been done", async () => {
    const { missing } = deriveSheet(campaign, context);
    // Even with pillars and an offer to seed from. Seeds are not research.
    expect(missing).toContain("keyword_research");
  });

  it("labels every seeded group as a seed, in the sheet itself", () => {
    const { derived } = deriveSheet(campaign, context);
    expect(derived.keyword_groups).toHaveLength(3);
    for (const group of derived.keyword_groups) {
      expect(group.note).toMatch(/Not keyword research\.$/);
    }
    // The note travels into the rendered sheet, not just the row, because the
    // rendered sheet is what somebody reads before typing it into Ads Manager.
    expect(renderSheet(derived, missing(campaign, context)).join("\n")).toContain(
      "Not keyword research",
    );
  });

  it("says there is nothing to seed from rather than inventing a theme", () => {
    const { derived, missing: gaps } = deriveSheet(campaign, {
      ...context,
      pillars: [],
      serviceName: null,
    });
    expect(derived.keyword_groups).toEqual([]);
    expect(gaps).toContain("themes_to_seed_from");
  });
});

function missing(c: SheetCampaign, ctx: Parameters<typeof deriveSheet>[1]) {
  return deriveSheet(c, ctx).missing;
}

describe("what it can say", () => {
  it("crosses themes with geography, which is how a local search campaign is built", () => {
    const groups = seedKeywordGroups(["garage conversion"], null, ["Portsmouth", "Southsea"]);
    expect(groups[0]!.seeds).toEqual([
      "garage conversion",
      "garage conversion Portsmouth",
      "garage conversion Southsea",
    ]);
  });

  it("leaves the places out when there is no geography", () => {
    const groups = seedKeywordGroups(["garage conversion"], null, []);
    expect(groups[0]!.seeds).toEqual(["garage conversion"]);
  });

  it("turns a daily budget into a ceiling somebody can check without arithmetic", () => {
    const { derived } = deriveSheet(campaign, context);
    expect(derived.campaign.daily_budget).toBe(40);
    expect(derived.campaign.monthly_ceiling).toBe(1200);
  });

  it("carries the destination, the conversion action and the signed offer", () => {
    const { derived } = deriveSheet(campaign, context);
    expect(derived.destination).toEqual({
      page_id: "page-1",
      url: "https://harbourhome.co.uk/garage-survey",
    });
    expect(derived.campaign.conversion_action).toBe("survey_booked");
    expect(derived.offer).toEqual({ version_id: "ver-3", promise: "Dry in four days" });
  });

  it("ships the negatives every service business wants before anybody thinks about it", () => {
    const { derived } = deriveSheet(campaign, context);
    expect(derived.negatives).toContain("free");
    expect(derived.negatives).toContain("jobs");
    expect(derived.negatives).toContain("diy");
  });
});

describe("an incomplete campaign", () => {
  it("names each gap instead of reading complete", () => {
    const { derived, missing: gaps } = deriveSheet(
      {
        ...campaign,
        daily_budget: null,
        target_countries: [],
        conversion_event: null,
        offer_version_id: null,
      },
      { ...context, pageId: null, pageUrl: null, approvedCopy: 0, serviceName: null },
    );

    expect(gaps).toEqual(
      expect.arrayContaining([
        "keyword_research",
        "geography",
        "daily_budget",
        "conversion_action",
        "landing_page",
        "approved_ad_copy",
        "signed_offer",
      ]),
    );
    // And nothing is quietly filled in with a plausible default.
    expect(derived.campaign.monthly_ceiling).toBeNull();
    expect(derived.ads).toEqual([]);
    expect(derived.destination.url).toBeNull();
  });

  it("puts the gaps in the rendered sheet, where a person reads them", () => {
    const sheet = deriveSheet(campaign, { ...context, pageId: null, pageUrl: null });
    const text = renderSheet(sheet.derived, sheet.missing).join("\n");
    expect(text).toContain("Still needed before this is a plan");
    expect(text).toContain("landing_page");
    expect(text).toContain("no page attached");
  });
});
