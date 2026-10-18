import { describe, expect, it } from "vitest";
import { sheetEvents } from "./index.js";
import { buildSheet } from "../meta_build/sheet.js";
import type { AssetRow, CampaignRow, MetaSettings } from "../meta_build/plan.js";

const TODAY = "2026-10-03";

/** What appendEvent truncates at. Nothing here may reach it. */
const APPEND_EVENT_LIMIT = 2000;

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

function eventsFor(assets: AssetRow[], c: CampaignRow = campaign()) {
  const result = buildSheet({ campaign: c, assets, settings, today: TODAY });
  if (!result.sheet) throw new Error(`Expected a sheet: ${result.problems.join(" / ")}`);
  return sheetEvents(result.sheet);
}

describe("sheetEvents", () => {
  it("numbers each section, so a log read newest-first can be put back in order", () => {
    const events = eventsFor([asset()]);
    expect(events[0]).toContain("1/5 Campaign");
    expect(events[1]).toContain("2/5 Ad set");
    expect(events[2]).toContain("3/5 Ad 1");
    expect(events[events.length - 1]).toContain("5/5 Bring these ids back into the console");
  });

  it("counts sections rather than ads, so two ads shift the numbering", () => {
    const events = eventsFor([asset(), asset({ id: "a2", title: "Second" })]);
    expect(events[0]).toContain("1/6 Campaign");
    expect(events.some((e) => e.includes("4/6 Ad 2"))).toBe(true);
  });

  it("keeps a section that fits in one event", () => {
    const events = eventsFor([asset()]);
    const campaignEvent = events[0]!;
    expect(campaignEvent).toContain("Objective: OUTCOME_LEADS");
    expect(campaignEvent).toContain("Status: PAUSED");
  });

  it("never writes a description appendEvent would truncate", () => {
    // Body copy Meta would accept and a job event would not.
    const events = eventsFor([asset({ ad_primary_text: "Open day. ".repeat(500) })]);
    for (const event of events) {
      expect(event.length).toBeLessThan(APPEND_EVENT_LIMIT);
    }
  });

  it("splits a long section instead of losing the end of it", () => {
    const events = eventsFor([
      asset({ ad_primary_text: "A".repeat(600), ad_description: "B".repeat(600), ad_headline: "C".repeat(600) }),
    ]);
    const adEvents = events.filter((e) => e.includes("Ad 1"));
    expect(adEvents.length).toBeGreaterThan(1);
    expect(adEvents.some((e) => e.includes("(continued)"))).toBe(true);
    // The fields that arrived last in the section are still there.
    expect(events.join("\n")).toContain("Link: https://example.com/open-day");
    expect(events.join("\n")).toContain("Call to action: SIGN_UP");
  });

  it("chunks a single line too long for any one event rather than dropping it", () => {
    const long = "D".repeat(4000);
    const events = eventsFor([asset({ ad_primary_text: long })]);
    // Joined back, the run is unbroken: nothing was dropped between chunks.
    expect(events.join("")).toContain(long);
    for (const event of events) expect(event.length).toBeLessThan(APPEND_EVENT_LIMIT);
  });

  it("carries the paused status and the warning on every ad", () => {
    const events = eventsFor([asset(), asset({ id: "a2" })]).join("\n");
    expect(events).not.toContain("ACTIVE");
    expect(events.match(/Status: PAUSED/g) ?? []).toHaveLength(4); // campaign, ad set, two ads
  });
});
