import { describe, expect, it } from "vitest";
import { buildPlan, buildProblem, isBuilt, type AssetState, type BuiltState } from "./build.js";

const asset = (over: Partial<AssetState> = {}): AssetState => ({
  assetId: "a1",
  imageHash: null,
  creativeId: null,
  adId: null,
  ...over,
});

const fresh: BuiltState = { campaignId: null, adSetId: null, assets: [asset()] };

describe("a build that has not started", () => {
  it("runs every step, campaign first", () => {
    expect(buildPlan(fresh)).toEqual([
      { step: "campaign" },
      { step: "ad_set" },
      { step: "upload", assetId: "a1" },
      { step: "creative", assetId: "a1" },
      { step: "ad", assetId: "a1" },
    ]);
  });

  it("groups per-asset work so a failure leaves whole ads", () => {
    const two: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [asset({ assetId: "a1" }), asset({ assetId: "a2" })],
    };
    expect(buildPlan(two).map((s) => `${s.step}:${"assetId" in s ? s.assetId : ""}`)).toEqual([
      "upload:a1",
      "creative:a1",
      "ad:a1",
      "upload:a2",
      "creative:a2",
      "ad:a2",
    ]);
  });
});

describe("pressing Build a second time", () => {
  it("does nothing when everything is recorded", () => {
    const done: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [asset({ imageHash: "h", creativeId: "cr", adId: "ad" })],
    };
    expect(buildPlan(done)).toEqual([]);
    expect(isBuilt(done)).toBe(true);
  });

  it("skips an asset that already has an ad, whatever else it is missing", () => {
    const done: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [asset({ imageHash: null, creativeId: "cr", adId: "ad" })],
    };
    expect(buildPlan(done)).toEqual([]);
  });

  it("never re-creates the campaign or the ad set once they exist", () => {
    const partial: BuiltState = { campaignId: "c", adSetId: "s", assets: [asset()] };
    expect(buildPlan(partial).map((s) => s.step)).not.toContain("campaign");
    expect(buildPlan(partial).map((s) => s.step)).not.toContain("ad_set");
  });
});

describe("resuming a build that failed part-way", () => {
  it("picks up from the ad set when only the campaign was made", () => {
    const state: BuiltState = { campaignId: "c", adSetId: null, assets: [asset()] };
    expect(buildPlan(state)[0]).toEqual({ step: "ad_set" });
  });

  it("reuses a cached image hash rather than uploading again", () => {
    const state: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [asset({ imageHash: "h" })],
    };
    expect(buildPlan(state).map((s) => s.step)).toEqual(["creative", "ad"]);
  });

  it("makes only the ad when the creative is already there", () => {
    const state: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [asset({ imageHash: "h", creativeId: "cr" })],
    };
    expect(buildPlan(state)).toEqual([{ step: "ad", assetId: "a1" }]);
  });

  it("finishes only the assets that are behind", () => {
    const state: BuiltState = {
      campaignId: "c",
      adSetId: "s",
      assets: [
        asset({ assetId: "done", imageHash: "h", creativeId: "cr", adId: "ad" }),
        asset({ assetId: "behind" }),
      ],
    };
    expect(buildPlan(state).every((s) => !("assetId" in s) || s.assetId === "behind")).toBe(true);
  });
});

describe("a record that disagrees with itself", () => {
  it("refuses an ad set with no campaign", () => {
    expect(buildProblem({ campaignId: null, adSetId: "s", assets: [asset()] })).toMatch(
      /ad set recorded but no campaign/,
    );
  });

  it("refuses an ad with no ad set", () => {
    expect(
      buildProblem({ campaignId: "c", adSetId: null, assets: [asset({ adId: "ad" })] }),
    ).toMatch(/ad recorded but the campaign has no ad set/);
  });

  it("refuses an ad with no creative behind it", () => {
    expect(
      buildProblem({ campaignId: "c", adSetId: "s", assets: [asset({ adId: "ad" })] }),
    ).toMatch(/ad recorded but no creative/);
  });

  it("refuses a build with nothing to build", () => {
    expect(buildProblem({ campaignId: null, adSetId: null, assets: [] })).toMatch(
      /no approved assets/,
    );
  });

  it("accepts every state that is merely unfinished", () => {
    expect(buildProblem(fresh)).toBeNull();
    expect(buildProblem({ campaignId: "c", adSetId: "s", assets: [asset({ imageHash: "h" })] })).toBeNull();
  });

  it("is not built while a problem stands", () => {
    expect(isBuilt({ campaignId: null, adSetId: "s", assets: [] })).toBe(false);
  });
});
