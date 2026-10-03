import { describe, expect, it } from "vitest";
import { buildSheet, renderSheet } from "./sheet.js";
import type { AssetRow, CampaignRow, MetaSettings } from "./plan.js";

const TODAY = "2026-09-23";

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    name: "Autumn open day",
    template: "O2",
    mirrors_template: null,
    optimisation_event: null,
    conversion_event: null,
    daily_budget: 50,
    target_countries: ["ZA"],
    starts_on: null,
    ends_on: null,
    meta_campaign_id: null,
    meta_ad_set_id: null,
    ...overrides,
  };
}

function asset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "a1",
    title: "Hero",
    media_type: "image",
    content_format: "single",
    storage_path: "client/a1.png",
    review_status: "approved",
    purpose: "content",
    ad_primary_text: "Come and see the school.",
    ad_headline: "Open day, 4 October",
    ad_description: null,
    ad_link_url: "https://example.com/open-day",
    ad_cta: "SIGN_UP",
    meta_image_hash: null,
    meta_creative_id: null,
    meta_ad_id: null,
    ...overrides,
  };
}

const settings: MetaSettings = { pageId: "1234", pixelId: null };

function sheetFor(c: CampaignRow, assets: AssetRow[], s: MetaSettings = settings, currency?: string) {
  const result = buildSheet({ campaign: c, assets, settings: s, today: TODAY, currency });
  if (!result.sheet) throw new Error(`Expected a sheet, got: ${result.problems.join(" / ")}`);
  return result.sheet;
}

describe("buildSheet", () => {
  it("takes the campaign's fields from the payload the runtime would have sent", () => {
    const sheet = sheetFor(campaign(), [asset()]);
    expect(sheet.campaign.name).toBe("Autumn open day");
    // O2's objective, not a word chosen here.
    expect(sheet.campaign.objective).toBe("OUTCOME_LEADS");
    expect(sheet.campaign.buyingType).toBe("AUCTION");
    expect(sheet.campaign.status).toBe("PAUSED");
    expect(sheet.adSet.status).toBe("PAUSED");
  });

  it("shows the budget in major units, because that is what Ads Manager asks for", () => {
    const sheet = sheetFor(campaign({ daily_budget: 50 }), [asset()]);
    expect(sheet.adSet.dailyBudget).toBe(50);
    expect(renderSheet(sheet)).toContain("50 per day");
    // The minor-unit figure the API would carry must not reach the sheet.
    expect(renderSheet(sheet)).not.toContain("5000");
  });

  it("names every ad's copy, page, link and button", () => {
    const sheet = sheetFor(campaign(), [asset({ ad_description: "Tours every hour." })]);
    expect(sheet.ads).toHaveLength(1);
    const ad = sheet.ads[0]!;
    expect(ad.pageId).toBe("1234");
    expect(ad.primaryText).toBe("Come and see the school.");
    expect(ad.headline).toBe("Open day, 4 October");
    expect(ad.description).toBe("Tours every hour.");
    expect(ad.link).toBe("https://example.com/open-day");
    expect(ad.cta).toBe("SIGN_UP");
    expect(ad.storagePath).toBe("client/a1.png");
  });

  it("declares the employment category when any asset is a hiring one", () => {
    const sheet = sheetFor(campaign(), [asset({ purpose: "recruitment" })]);
    expect(sheet.campaign.specialAdCategories).toEqual(["EMPLOYMENT"]);
    expect(renderSheet(sheet)).toContain("EMPLOYMENT — must be declared");
  });

  it("carries the promoted object a conversion goal needs", () => {
    const sheet = sheetFor(
      campaign({ template: "R1", conversion_event: "LEAD" }),
      [asset({ ad_cta: "LEARN_MORE" })],
      { pageId: "1234", pixelId: "9876" },
    );
    expect(sheet.adSet.optimisationGoal).toBe("OFFSITE_CONVERSIONS");
    expect(sheet.adSet.promotedObject).toEqual({ pixel_id: "9876", custom_event_type: "LEAD" });
  });

  it("refuses rather than writing a sheet the runtime would refuse to build", () => {
    const result = buildSheet({
      campaign: campaign({ daily_budget: null, target_countries: [] }),
      assets: [asset()],
      settings,
      today: TODAY,
    });
    expect(result.sheet).toBeNull();
    expect(result.problems).toContain("Set a daily budget for this campaign.");
    expect(result.problems).toContain("Choose at least one country for this campaign to run in.");
  });

  it("refuses when no approved asset carries copy", () => {
    const result = buildSheet({
      campaign: campaign(),
      assets: [asset({ review_status: "pending" })],
      settings,
      today: TODAY,
    });
    expect(result.sheet).toBeNull();
    expect(result.problems.join(" ")).toContain("No approved image in this campaign has ad copy");
  });

  it("marks what already exists so a hand build does not duplicate it", () => {
    const sheet = sheetFor(
      campaign({ meta_campaign_id: "120200", meta_ad_set_id: "120300" }),
      [asset({ meta_ad_id: "120400" })],
    );
    expect(sheet.campaign.existingId).toBe("120200");
    expect(sheet.adSet.existingId).toBe("120300");
    expect(sheet.ads[0]!.alreadyBuilt).toBe(true);
    const text = renderSheet(sheet);
    expect(text).toContain("already exists: 120200");
    expect(text).toContain("already built — skip");
  });

  it("warns that the currency was assumed only when it was not supplied", () => {
    const assumed = sheetFor(campaign(), [asset()]);
    expect(assumed.caveats.join(" ")).toContain("not read from Meta");
    const known = sheetFor(campaign(), [asset()], settings, "ZAR");
    expect(known.caveats.join(" ")).not.toContain("not read from Meta");
  });
});

describe("renderSheet", () => {
  it("says paused at the top and never says otherwise", () => {
    const text = renderSheet(sheetFor(campaign(), [asset()]));
    expect(text.split("\n")[0]).toContain("PAUSED");
    expect(text).not.toContain("ACTIVE");
  });

  it("ends by asking for the ids back, and says what goes wrong without them", () => {
    const text = renderSheet(sheetFor(campaign(), [asset()]));
    expect(text).toContain("Bring these ids back into the console");
    expect(text).toContain("creates a second campaign");
  });
});
