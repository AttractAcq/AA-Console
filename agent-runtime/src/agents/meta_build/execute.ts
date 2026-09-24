/**
 * Running a build plan against the ad account.
 *
 * build.ts decides what is left to create; this creates it, one step at a
 * time, and writes each id down the moment Meta returns it. That ordering is
 * the whole safety story: a failure part-way through leaves every object that
 * was made recorded, so the next run picks up from the step that failed
 * instead of making a second campaign.
 *
 * The Meta calls and the database writes come in as two small interfaces so
 * a test can fail any step and watch what the next run does.
 */

import type { BuildStep } from "../../meta/build.js";
import type { AssetRow, Payloads } from "./plan.js";

/**
 * Meta made something and it could not be written down.
 *
 * The one failure a retry must not follow: the next run would read an empty
 * id and create the object again. The runner stops on this instead.
 */
export class UnrecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecordedError";
  }
}

export interface MetaWriter {
  createCampaign(payload: Record<string, unknown>): Promise<{ id: string }>;
  createAdSet(payload: Record<string, unknown>): Promise<{ id: string }>;
  uploadImage(image: { bytes: Uint8Array; filename: string }): Promise<{ hash: string }>;
  createCreative(payload: Record<string, unknown>): Promise<{ id: string }>;
  createAd(payload: Record<string, unknown>): Promise<{ id: string }>;
}

export interface BuildStore {
  saveCampaignId(id: string): Promise<void>;
  saveAdSetId(id: string): Promise<void>;
  saveImageHash(assetId: string, hash: string): Promise<void>;
  saveCreativeId(assetId: string, id: string): Promise<void>;
  saveAdId(assetId: string, id: string): Promise<void>;
  loadImage(asset: AssetRow): Promise<{ bytes: Uint8Array; filename: string }>;
}

/** What is known so far, updated as each step lands. */
export interface Progress {
  campaignId: string | null;
  adSetId: string | null;
  imageHash: Map<string, string>;
  creativeId: Map<string, string>;
}

export function progressFrom(campaign: { meta_campaign_id: string | null; meta_ad_set_id: string | null }, ads: readonly AssetRow[]): Progress {
  const imageHash = new Map<string, string>();
  const creativeId = new Map<string, string>();
  for (const a of ads) {
    if (a.meta_image_hash) imageHash.set(a.id, a.meta_image_hash);
    if (a.meta_creative_id) creativeId.set(a.id, a.meta_creative_id);
  }
  return {
    campaignId: campaign.meta_campaign_id,
    adSetId: campaign.meta_ad_set_id,
    imageHash,
    creativeId,
  };
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || value === "") {
    // build.ts orders the steps so this cannot happen; if it does, stopping
    // is the only safe move, because carrying on would send an id of "".
    throw new Error(`The build reached a step before its ${what} existed.`);
  }
  return value;
}

/**
 * Runs the steps in order. Throws whatever the failing step threw, after
 * everything before it has been recorded.
 */
export async function executeBuild(args: {
  steps: readonly BuildStep[];
  ads: readonly AssetRow[];
  payloads: Payloads;
  progress: Progress;
  meta: MetaWriter;
  store: BuildStore;
  log: (line: string) => Promise<void>;
}): Promise<Progress> {
  const { steps, payloads, progress, meta, store, log } = args;
  const byId = new Map(args.ads.map((a) => [a.id, a]));
  const asset = (id: string) => need(byId.get(id), `asset ${id}`);

  for (const step of steps) {
    switch (step.step) {
      case "campaign": {
        const { id } = await meta.createCampaign({ ...payloads.campaign() });
        await store.saveCampaignId(id);
        progress.campaignId = id;
        await log(`Created campaign ${id} (paused).`);
        break;
      }
      case "ad_set": {
        const campaignId = need(progress.campaignId, "campaign");
        const { id } = await meta.createAdSet({ ...payloads.adSet(campaignId) });
        await store.saveAdSetId(id);
        progress.adSetId = id;
        await log(`Created ad set ${id} (paused).`);
        break;
      }
      case "upload": {
        const row = asset(step.assetId);
        const image = await store.loadImage(row);
        const { hash } = await meta.uploadImage(image);
        await store.saveImageHash(row.id, hash);
        progress.imageHash.set(row.id, hash);
        await log(`Uploaded the image for ${row.title ?? row.id}.`);
        break;
      }
      case "creative": {
        const row = asset(step.assetId);
        const hash = need(progress.imageHash.get(row.id), `image for ${row.id}`);
        const { id } = await meta.createCreative({ ...payloads.creative(row, hash) });
        await store.saveCreativeId(row.id, id);
        progress.creativeId.set(row.id, id);
        await log(`Created creative ${id} for ${row.title ?? row.id}.`);
        break;
      }
      case "ad": {
        const row = asset(step.assetId);
        const adSetId = need(progress.adSetId, "ad set");
        const creativeId = need(progress.creativeId.get(row.id), `creative for ${row.id}`);
        const { id } = await meta.createAd({ ...payloads.ad(row, adSetId, creativeId) });
        await store.saveAdId(row.id, id);
        await log(`Created ad ${id} for ${row.title ?? row.id} (paused).`);
        break;
      }
    }
  }
  return progress;
}
