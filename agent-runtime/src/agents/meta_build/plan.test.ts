import { describe, expect, it } from "vitest";
import { buildPlan } from "../../meta/build.js";
import {
  builtState,
  isAdCandidate,
  payloadsFor,
  preflight,
  purposeOf,
  resolveSpec,
  type AssetRow,
  type CampaignRow,
  type MetaSettings,
} from "./plan.js";

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

function check(c: CampaignRow, assets: AssetRow[], s = settings) {
  return preflight({ campaign: c, assets, settings: s, currency: "ZAR", today: TODAY });
}

describe("resolveSpec", () => {
  it("takes the objective and goal from the template", () => {
    const spec = resolveSpec(campaign());
    expect(spec).toMatchObject({ objective: "OUTCOME_LEADS", optimisation: "LEAD_GENERATION" });
  });

  it("prefers the campaign's own optimisation event", () => {
    const spec = resolveSpec(campaign({ optimisation_event: "LANDING_PAGE_VIEWS" }));
    expect(spec).toMatchObject({ optimisation: "LANDING_PAGE_VIEWS" });
  });

  it("borrows a mirrored template's objective", () => {
    const spec = resolveSpec(campaign({ template: "X2", mirrors_template: "R1" }));
    expect(spec).toMatchObject({ objective: "OUTCOME_LEADS", optimisation: "OFFSITE_CONVERSIONS" });
  });

  it("refuses a campaign with no template", () => {
    expect(resolveSpec(campaign({ template: null }))).toEqual({
      problem: expect.stringMatching(/no template/),
    });
  });

  it("refuses destinations that need a creative shape this cannot build", () => {
    for (const code of ["P1", "P2", "P3", "P4", "R4"]) {
      expect(resolveSpec(campaign({ template: code })), code).toEqual({
        problem: expect.stringMatching(/Only templates that point at a page/),
      });
    }
  });
});

describe("which assets become ads", () => {
  it("takes approved assets that carry copy", () => {
    expect(isAdCandidate(asset())).toBe(true);
  });

  it("leaves out an approved asset with no copy: it is content, not an ad", () => {
    expect(
      isAdCandidate(asset({ ad_primary_text: null, ad_headline: null, ad_link_url: null, ad_cta: null })),
    ).toBe(false);
  });

  it("leaves out anything not approved, or with no file", () => {
    expect(isAdCandidate(asset({ review_status: "pending" }))).toBe(false);
    expect(isAdCandidate(asset({ storage_path: "" }))).toBe(false);
  });

  it("declares a campaign with any hiring ad as employment", () => {
    expect(purposeOf([asset(), asset({ id: "a2", purpose: "recruitment" })])).toBe("recruitment");
    expect(purposeOf([asset()])).toBe("content");
  });
});

describe("preflight", () => {
  it("passes a complete campaign", () => {
    const result = check(campaign(), [asset()]);
    expect(result.problems).toEqual([]);
    expect(result.inputs?.ads.map((a) => a.id)).toEqual(["a1"]);
  });

  it("reports every missing input at once, not one per attempt", () => {
    const { problems, inputs } = check(
      campaign({ daily_budget: null, target_countries: [] }),
      [asset({ ad_headline: "" })],
      { pageId: null, pixelId: null },
    );
    expect(inputs).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining([
        "Set a daily budget for this campaign.",
        "Choose at least one country for this campaign to run in.",
        expect.stringMatching(/no Facebook page/),
        expect.stringMatching(/"Hero": .*headline/),
      ]),
    );
  });

  it("refuses a campaign with no ads to build", () => {
    const bare = asset({ ad_primary_text: null, ad_headline: null, ad_link_url: null, ad_cta: null });
    expect(check(campaign(), [bare]).problems).toEqual([expect.stringMatching(/No approved image .* ad copy/)]);
  });

  it("refuses a video carrying copy rather than silently skipping it", () => {
    const { problems } = check(campaign(), [asset(), asset({ id: "v", title: "Clip", media_type: "video" })]);
    expect(problems).toEqual([expect.stringMatching(/"Clip" is a video/)]);
  });

  it("refuses a carousel, which is several frames rather than one image", () => {
    const { problems } = check(campaign(), [asset(), asset({ id: "c", title: "Steps", content_format: "carousel" })]);
    expect(problems).toEqual([expect.stringMatching(/"Steps" is a carousel/)]);
  });

  it("refuses a button the template's destination cannot serve", () => {
    const { problems } = check(campaign(), [asset({ ad_cta: "SEND_MESSAGE" })]);
    expect(problems).toEqual([expect.stringMatching(/"Hero": SEND_MESSAGE cannot point at page/)]);
  });

  it("refuses a link that is not https before Meta sees it", () => {
    const { problems } = check(campaign(), [asset({ ad_link_url: "example.com" })]);
    expect(problems).toEqual([expect.stringMatching(/not an https destination/)]);
  });

  it("refuses a conversion goal with no pixel, before the campaign is created", () => {
    const { problems } = check(campaign({ template: "R1" }), [asset({ ad_cta: "BOOK_NOW" })]);
    expect(problems).toEqual([expect.stringMatching(/needs a pixel/)]);
  });

  it("refuses a conversion goal with no event to count", () => {
    const { problems } = check(campaign({ template: "R1" }), [asset({ ad_cta: "BOOK_NOW" })], {
      pageId: "1",
      pixelId: "99",
    });
    expect(problems).toEqual([expect.stringMatching(/needs the event it counts/)]);
  });

  it("refuses a campaign that has already ended", () => {
    const { problems } = check(campaign({ ends_on: "2026-09-01" }), [asset()]);
    expect(problems).toEqual([expect.stringMatching(/ended on 2026-09-01/)]);
  });

  it("reports a problem with the ad set even when another problem exists", () => {
    const { problems } = check(campaign({ template: "R1" }), [asset({ ad_cta: "BOOK_NOW", ad_link_url: "nope" })]);
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/needs a pixel/), expect.stringMatching(/https/)]),
    );
  });
});

describe("payloads", () => {
  const inputs = () => check(campaign({ daily_budget: 50.5, starts_on: "2026-10-01", ends_on: "2026-10-31" }), [asset()]).inputs!;

  it("sends the budget in the account's minor units, paused", () => {
    const c = campaign({ daily_budget: 50.5, starts_on: "2026-10-01", ends_on: "2026-10-31" });
    const adSet = payloadsFor(c, inputs()).adSet("111");
    expect(adSet).toMatchObject({
      campaign_id: "111",
      daily_budget: 5050,
      status: "PAUSED",
      optimization_goal: "LEAD_GENERATION",
      targeting: { geo_locations: { countries: ["ZA"] } },
      promoted_object: { page_id: "1234" },
      start_time: "2026-10-01",
      end_time: "2026-10-31",
    });
  });

  it("does not send a start date that has already passed", () => {
    const c = campaign({ starts_on: "2026-09-01" });
    const adSet = payloadsFor(c, check(c, [asset()]).inputs!).adSet("111");
    expect(adSet).not.toHaveProperty("start_time");
  });

  it("puts the asset's own words on the creative", () => {
    const c = campaign();
    const creative = payloadsFor(c, check(c, [asset()]).inputs!).creative(asset(), "hash1");
    expect(creative.object_story_spec).toEqual({
      page_id: "1234",
      link_data: {
        image_hash: "hash1",
        link: "https://example.com/open-day",
        message: "Come and see the school.",
        name: "Open day, 4 October",
        call_to_action: { type: "SIGN_UP", value: { link: "https://example.com/open-day" } },
      },
    });
  });
});

describe("builtState", () => {
  it("plans only what is not already recorded", () => {
    const state = builtState(campaign({ meta_campaign_id: "9", meta_ad_set_id: "8" }), [
      asset({ meta_image_hash: "h", meta_creative_id: "cr", meta_ad_id: "ad" }),
      asset({ id: "a2", meta_image_hash: "h2" }),
    ]);
    expect(buildPlan(state)).toEqual([
      { step: "creative", assetId: "a2" },
      { step: "ad", assetId: "a2" },
    ]);
  });
});
