/**
 * What is left to build in the ad account.
 *
 * Creating a campaign is not idempotent: Meta will happily make a second one
 * with the same name, and a second ad set under it, and a second set of ads.
 * Nothing about the account would look wrong, and the budget would double the
 * moment somebody launched both.
 *
 * So a build is never "create everything". It is "create what is not already
 * recorded", and the ids written back after each step are what makes pressing
 * Build twice safe. A step that succeeded at Meta but whose id was not
 * recorded is the one case this cannot see, which is why each id is written
 * as soon as it comes back rather than all of them at the end.
 */

export interface AssetState {
  assetId: string;
  /** Meta dedupes uploads by content, so a cached hash is safe to reuse. */
  imageHash: string | null;
  creativeId: string | null;
  adId: string | null;
}

export interface BuiltState {
  campaignId: string | null;
  adSetId: string | null;
  assets: readonly AssetState[];
}

export type BuildStep =
  | { step: "campaign" }
  | { step: "ad_set" }
  | { step: "upload"; assetId: string }
  | { step: "creative"; assetId: string }
  | { step: "ad"; assetId: string };

/**
 * Why this state cannot be built on, or null if it can.
 *
 * An ad set with no campaign, or an ad with no ad set, is not a partial build
 * — it is a record that disagrees with itself. Carrying on would create a
 * second campaign and leave the orphan behind, so it stops and says so.
 */
export function buildProblem(state: BuiltState): string | null {
  if (state.adSetId && !state.campaignId) {
    return "This campaign has an ad set recorded but no campaign. Check the ad account before building again.";
  }
  const orphanAd = state.assets.find((a) => a.adId && !state.adSetId);
  if (orphanAd) {
    return `Asset ${orphanAd.assetId} has an ad recorded but the campaign has no ad set. Check the ad account before building again.`;
  }
  const adWithoutCreative = state.assets.find((a) => a.adId && !a.creativeId);
  if (adWithoutCreative) {
    return `Asset ${adWithoutCreative.assetId} has an ad recorded but no creative. Check the ad account before building again.`;
  }
  if (state.assets.length === 0) {
    return "There are no approved assets to build ads from.";
  }
  return null;
}

/**
 * The steps still to run, in the order they must run.
 *
 * Campaign before ad set before creatives before ads, because each carries
 * the id of the one above it. Per-asset work is grouped by asset so a
 * failure part-way leaves whole ads rather than creatives with nothing
 * carrying them.
 */
export function buildPlan(state: BuiltState): BuildStep[] {
  const steps: BuildStep[] = [];
  if (!state.campaignId) steps.push({ step: "campaign" });
  if (!state.adSetId) steps.push({ step: "ad_set" });

  for (const asset of state.assets) {
    if (asset.adId) continue;
    if (!asset.imageHash) steps.push({ step: "upload", assetId: asset.assetId });
    if (!asset.creativeId) steps.push({ step: "creative", assetId: asset.assetId });
    steps.push({ step: "ad", assetId: asset.assetId });
  }
  return steps;
}

/** Nothing left to do. */
export function isBuilt(state: BuiltState): boolean {
  return buildProblem(state) === null && buildPlan(state).length === 0;
}
