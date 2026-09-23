import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPlan } from "../../meta/build.js";
import { MetaWriteError } from "../../meta/ads.js";
import { UnrecordedError, executeBuild, progressFrom, type BuildStore, type MetaWriter } from "./execute.js";
import { buildFailure } from "./index.js";
import { builtState, preflight, payloadsFor, type AssetRow, type CampaignRow } from "./plan.js";

function campaignRow(): CampaignRow {
  return {
    id: "c1",
    name: "Open day",
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
  };
}

function assetRow(id: string): AssetRow {
  return {
    id,
    title: `Asset ${id}`,
    media_type: "image",
    content_format: "single",
    storage_path: `client/${id}.png`,
    review_status: "approved",
    purpose: "content",
    ad_primary_text: "Come and see.",
    ad_headline: "Open day",
    ad_description: null,
    ad_link_url: "https://example.com",
    ad_cta: "SIGN_UP",
    meta_image_hash: null,
    meta_creative_id: null,
    meta_ad_id: null,
  };
}

/**
 * A fake account and a fake database that share the rows, so a second run
 * reads what the first one recorded — the property the whole design rests on.
 */
function world(assetIds: string[]) {
  const campaign = campaignRow();
  const assets = assetIds.map(assetRow);
  let next = 100;
  const created: string[] = [];
  const failOn = new Set<string>();

  const call = (kind: string) => async (payload: Record<string, unknown>) => {
    if (failOn.has(kind)) throw new MetaWriteError(`${kind} refused`, true, 500);
    expect(payload.status ?? "PAUSED").toBe("PAUSED");
    created.push(kind);
    return { id: String(next++) };
  };
  const meta: MetaWriter = {
    createCampaign: call("campaign"),
    createAdSet: call("ad_set"),
    createCreative: call("creative"),
    createAd: call("ad"),
    uploadImage: async () => {
      if (failOn.has("upload")) throw new MetaWriteError("upload refused", true, 500);
      created.push("upload");
      return { hash: `h${next++}` };
    },
  };
  const find = (id: string) => assets.find((a) => a.id === id)!;
  const store: BuildStore = {
    saveCampaignId: async (id) => void (campaign.meta_campaign_id = id),
    saveAdSetId: async (id) => void (campaign.meta_ad_set_id = id),
    saveImageHash: async (a, h) => void (find(a).meta_image_hash = h),
    saveCreativeId: async (a, id) => void (find(a).meta_creative_id = id),
    saveAdId: async (a, id) => void (find(a).meta_ad_id = id),
    loadImage: async (a) => ({ bytes: new Uint8Array([1]), filename: `${a.id}.png` }),
  };

  async function run() {
    const { inputs } = preflight({
      campaign,
      assets,
      settings: { pageId: "1", pixelId: null },
      currency: "ZAR",
      today: "2026-09-23",
    });
    const steps = buildPlan(builtState(campaign, inputs!.ads));
    await executeBuild({
      steps,
      ads: inputs!.ads,
      payloads: payloadsFor(campaign, inputs!),
      progress: progressFrom(campaign, inputs!.ads),
      meta,
      store,
      log: async () => {},
    });
    return steps.length;
  }

  return { campaign, assets, created, failOn, run };
}

describe("executeBuild", () => {
  it("builds the whole structure and records every id", async () => {
    const w = world(["a", "b"]);
    await w.run();
    expect(w.created).toEqual(["campaign", "ad_set", "upload", "creative", "ad", "upload", "creative", "ad"]);
    expect(w.campaign.meta_campaign_id).toBeTruthy();
    expect(w.assets.every((a) => a.meta_ad_id)).toBe(true);
  });

  it("builds nothing the second time", async () => {
    const w = world(["a"]);
    await w.run();
    w.created.length = 0;
    expect(await w.run()).toBe(0);
    expect(w.created).toEqual([]);
  });

  it("resumes from the failed step instead of making a second campaign", async () => {
    const w = world(["a", "b"]);
    w.failOn.add("ad");
    await expect(w.run()).rejects.toThrow(/ad refused/);
    const campaignId = w.campaign.meta_campaign_id;
    expect(campaignId).toBeTruthy();
    expect(w.assets[0]!.meta_creative_id).toBeTruthy();

    w.failOn.clear();
    w.created.length = 0;
    await w.run();
    expect(w.created).toEqual(["ad", "upload", "creative", "ad"]);
    expect(w.campaign.meta_campaign_id).toBe(campaignId);
  });

  it("refuses to send a step whose parent id is missing", async () => {
    await expect(
      executeBuild({
        steps: [{ step: "ad_set" }],
        ads: [],
        payloads: {} as never,
        progress: { campaignId: null, adSetId: null, imageHash: new Map(), creativeId: new Map() },
        meta: {} as never,
        store: {} as never,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/before its campaign existed/);
  });
});

describe("buildFailure", () => {
  it("retries what Meta answered and called retryable", () => {
    expect(buildFailure(new MetaWriteError("rate limited", true, 400))).toMatchObject({ retryable: true });
    expect(buildFailure(new MetaWriteError("bad token", false, 400))).toMatchObject({ retryable: false });
  });

  it("does not retry a request Meta never answered, which may have landed", () => {
    const result = buildFailure(new MetaWriteError("Could not reach the Marketing API", true, null));
    expect(result.retryable).toBe(false);
    expect(result.failureMessage).toMatch(/Check Ads Manager/);
  });

  it("does not retry an id that could not be recorded", () => {
    expect(buildFailure(new UnrecordedError("not saved"))).toMatchObject({ retryable: false });
  });

  it("does not retry an unexpected error mid-build", () => {
    expect(buildFailure(new Error("boom"))).toMatchObject({ retryable: false });
  });
});

/** Same guard as src/meta: nothing in this runner can ask for a live object. */
it("contains no ACTIVE status anywhere in the runner", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/["']ACTIVE["']/);
  }
});
