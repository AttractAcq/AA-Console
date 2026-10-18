import { describe, expect, it } from "vitest";
import { preflight, payloadsFor, type AssetRow, type CampaignRow } from "../meta_build/plan.js";
import { RECRUITMENT_SPEC } from "./index.js";

const campaign: CampaignRow = {
  id: "campaign", name: "AA editor hiring", template: null, mirrors_template: null,
  optimisation_event: null, conversion_event: "SUBMIT_APPLICATION",
  daily_budget: 25, target_countries: ["ZA"], starts_on: null, ends_on: null,
  meta_campaign_id: null, meta_ad_set_id: null,
};
const asset: AssetRow = {
  id: "image", title: "Editor ad", media_type: "image", content_format: "single",
  storage_path: "hiring/editor.png", review_status: "approved", purpose: "recruitment",
  ad_primary_text: "We're hiring an editor.", ad_headline: "Join AA",
  ad_description: null, ad_link_url: "https://example.com/apply", ad_cta: "APPLY_NOW",
  meta_image_hash: null, meta_creative_id: null, meta_ad_id: null,
};
const settings = { pageId: "12345", pixelId: "67890" };

describe("AA recruitment Meta build", () => {
  it("preflights selected ads and creates paused employment payloads", () => {
    const result = preflight({ campaign, assets: [asset], settings, currency: "ZAR", today: "2026-09-26", spec: RECRUITMENT_SPEC });
    expect(result.problems).toEqual([]);
    const payloads = payloadsFor(campaign, result.inputs!);
    expect(payloads.campaign()).toMatchObject({
      objective: "OUTCOME_LEADS", status: "PAUSED", special_ad_categories: ["EMPLOYMENT"],
    });
    expect(payloads.adSet("111")).toMatchObject({ status: "PAUSED", daily_budget: 2500 });
    expect(payloads.ad(asset, "222", "333")).toMatchObject({ status: "PAUSED" });
  });

  it("refuses missing pixel, non-image and unapproved selections before any write", () => {
    expect(preflight({ campaign, assets: [asset], settings: { ...settings, pixelId: null }, currency: "ZAR", today: "2026-09-26", spec: RECRUITMENT_SPEC }).inputs).toBeNull();
    expect(preflight({ campaign, assets: [{ ...asset, media_type: "video" }], settings, currency: "ZAR", today: "2026-09-26", spec: RECRUITMENT_SPEC }).inputs).toBeNull();
    expect(preflight({ campaign, assets: [{ ...asset, review_status: "pending" }], settings, currency: "ZAR", today: "2026-09-26", spec: RECRUITMENT_SPEC }).inputs).toBeNull();
  });
});
