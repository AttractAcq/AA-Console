import assert from "node:assert/strict";
import { test } from "node:test";
import { deployVerified, releasePlan } from "./deploy-lambda.mjs";

const sha = "a".repeat(40);
const plan = releasePlan({ sha, expectedSha: sha, region: "eu-west-1",
  clean: true, licenseConfirmed: true, execute: true });

test("release plan requires the exact clean reviewed source and licence", () => {
  assert.equal(plan.siteName, "aa-video-aaaaaaaaaaaa");
  assert.throws(() => releasePlan({ sha, expectedSha: "b".repeat(40),
    region: "eu-west-1", clean: true, licenseConfirmed: true, execute: true }));
  assert.throws(() => releasePlan({ sha, expectedSha: sha,
    region: "eu-west-1", clean: false, licenseConfirmed: true, execute: true }));
  assert.throws(() => releasePlan({ sha, expectedSha: sha,
    region: "eu-west-1", clean: true, licenseConfirmed: false, execute: true }));
});

test("deployment yields settings only after function and site read-back", async () => {
  const calls = [];
  const provider = {
    deployFunction: async (args) => { calls.push(["function", args.region]);
      return { functionName: "remotion-render-4-0-545" }; },
    getOrCreateBucket: async () => ({ bucketName: "remotionlambda-test" }),
    deploySite: async (args) => ({ siteName: args.siteName,
      serveUrl: "https://example.invalid/sites/aa-video/index.html" }),
    getFunctionInfo: async () => ({ functionName: "remotion-render-4-0-545",
      version: "4.0.545", memorySizeInMb: 3009,
      diskSizeInMb: 4096, timeoutInSeconds: 900 }),
    getCompositionsOnLambda: async () => plan.expectedCompositions.map((id) => ({ id })),
  };
  const result = await deployVerified(plan, provider);
  assert.equal(result.sourceSha, sha);
  assert.equal(result.compositions.length, 4);
  assert.deepEqual(calls, [["function", "eu-west-1"]]);
  await assert.rejects(() => deployVerified(plan, { ...provider,
    getCompositionsOnLambda: async () => [{ id: "VideoThumbnail" }] }),
  /missing a required/);
});
