// Manual, paid evaluation of the real storyboard and independent-review prompts.
// This is not the rendered-video/vision-critic acceptance gate.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { estimateCostUsd } from "../usage/cost.js";
import { reviewVideoStoryboard, VIDEO_REVIEW_SYSTEM,
  VideoReviewValidationError } from "../video/review.js";
import { writeVideoStoryboard, VideoStoryboardValidationError,
  type VideoCompletion, type VideoSource, type VideoStoryboardRequest } from "../video/storyboard.js";

type Case = Omit<VideoStoryboardRequest, "catalogue"> & { id: string };
type Result = {
  id: string; writerValid: boolean; reviewerAccepted: boolean | null;
  writerAttempts: number | null; reviewerEdits: number | null;
  reasons: string[]; estimatedCostUsd: number;
  irSha256: string | null; reviewedIr: unknown | null;
  sceneSources: unknown | null; error: string | null;
  // The vision critic runs after audio and render. This script does not run it.
  visionCriticLoops: null;
};

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const fixtureUrl = new URL("../../eval/video/ideas.json", import.meta.url);
const catalogueUrl = new URL("../video/catalogue.md", import.meta.url);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function manifest(raw: unknown): Case[] {
  if (!Array.isArray(raw) || raw.length !== 20) {
    throw new Error("Video evaluation manifest must contain exactly 20 cases.");
  }
  const ids = new Set<string>();
  return raw.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Video evaluation case must be an object.");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^\d{2}-[a-z-]+$/.test(row.id)
      || ids.has(row.id) || typeof row.idea !== "string"
      || row.idea.trim().length < 15 || typeof row.audience !== "string"
      || !["calm", "confident", "energetic"].includes(row.tone as string)
      || !Number.isInteger(row.targetLengthSec) || !Array.isArray(row.aspects)
      || !Array.isArray(row.sources)) {
      throw new Error("Video evaluation case has invalid or duplicate fields.");
    }
    ids.add(row.id);
    return row as Case;
  });
}

function completion(client: Anthropic, model: string, system?: string): VideoCompletion {
  return async (prompt) => {
    const response = await client.messages.stream({ model, max_tokens: 8192,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }).finalMessage();
    const text = response.content.filter((part): part is Anthropic.Messages.TextBlock =>
      part.type === "text").map((part) => part.text).join("\n");
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
    return { text, usage: { inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens,
      costUsd: estimateCostUsd(model, { inputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens }) } };
  };
}

async function evaluate(test: Case, catalogue: string,
  writer: VideoCompletion, reviewer: VideoCompletion): Promise<Result> {
  const result: Result = { id: test.id, writerValid: false,
    reviewerAccepted: null, writerAttempts: null, reviewerEdits: null,
    reasons: [], estimatedCostUsd: 0, irSha256: null,
    reviewedIr: null, sceneSources: null, error: null,
    visionCriticLoops: null };
  try {
    const storyboard = await writeVideoStoryboard({ ...test, catalogue }, writer);
    result.writerValid = true;
    result.writerAttempts = storyboard.attempts;
    result.estimatedCostUsd += storyboard.usage.costUsd;
    const review = await reviewVideoStoryboard(storyboard,
      test.sources as VideoSource[], reviewer);
    result.reviewerAccepted = review.accepted;
    result.reviewerEdits = review.edits;
    result.reasons = review.reasons;
    result.estimatedCostUsd += review.usage.costUsd;
    if (review.accepted) {
      result.irSha256 = digest(JSON.stringify(review.ir));
      result.reviewedIr = review.ir;
      result.sceneSources = review.sceneSources;
    }
  } catch (caught) {
    if (caught instanceof VideoStoryboardValidationError) {
      result.writerAttempts = caught.attempts;
      result.estimatedCostUsd += caught.usage?.costUsd ?? 0;
      result.reasons = caught.problems;
      result.error = "storyboard_validation";
    } else if (caught instanceof VideoReviewValidationError) {
      result.estimatedCostUsd += caught.usage.costUsd;
      result.error = "review_validation";
      result.reasons = [caught.reason];
    } else {
      // Provider errors can have uncertain billing. Do not report zero cost as proof.
      result.error = "provider_or_runtime_error";
      result.reasons = [caught instanceof Error ? caught.name : "unknown error"];
    }
  }
  return result;
}

async function main(): Promise<void> {
  const fixture = await readFile(fixtureUrl, "utf8");
  const catalogue = await readFile(catalogueUrl, "utf8");
  const cases = manifest(JSON.parse(fixture));
  if (process.argv.includes("--check")) {
    process.stdout.write(JSON.stringify({ cases: cases.length,
      fixtureSha256: digest(fixture), catalogueSha256: digest(catalogue) }) + "\n");
    return;
  }
  const limit = Number(option("--limit"));
  const maxUsd = Number(option("--max-usd"));
  const out = option("--out");
  const model = process.env.VIDEO_SCRIPT_MODEL?.trim();
  const key = process.env.ANTHROPIC_API_KEY_VIDEO_SCRIPT?.trim()
    || process.env.ANTHROPIC_API_KEY?.trim();
  if (!Number.isInteger(limit) || limit < 1 || limit > 20
    || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 100
    || !out || !model || !key) {
    throw new Error("Run with --limit 1..20 --max-usd 0..100 --out <new JSON path>, VIDEO_SCRIPT_MODEL and an Anthropic key. No model call was made.");
  }
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 180_000 });
  const writer = completion(client, model);
  const reviewer = completion(client, model, VIDEO_REVIEW_SYSTEM);
  const results: Result[] = [];
  let estimatedCostUsd = 0;
  for (const test of cases.slice(0, limit)) {
    if (estimatedCostUsd >= maxUsd) break;
    const result = await evaluate(test, catalogue, writer, reviewer);
    results.push(result);
    estimatedCostUsd += result.estimatedCostUsd;
  }
  const report = {
    kind: "video_script_review_evaluation_v1",
    createdAt: new Date().toISOString(), model,
    fixtureSha256: digest(fixture), catalogueSha256: digest(catalogue),
    selectedCases: limit, completedCases: results.length,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1e6) / 1e6,
    costCoverage: results.some((result) => result.error === "provider_or_runtime_error")
      ? "incomplete_provider_billing_unknown" : "model_usage_estimate_not_provider_invoice",
    writerValidateRate: results.length
      ? results.filter((result) => result.writerValid).length / results.length : null,
    reviewerAcceptRate: results.length
      ? results.filter((result) => result.reviewerAccepted).length / results.length : null,
    // Audio, render, vision critic and human assessment require separate evidence.
    visionCriticOutcomes: null, goldRenders: [], humanReview: null,
    results,
  };
  await writeFile(resolve(out),
    JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ completedCases: report.completedCases,
    writerValidateRate: report.writerValidateRate,
    reviewerAcceptRate: report.reviewerAcceptRate,
    estimatedCostUsd: report.estimatedCostUsd,
    costCoverage: report.costCoverage }) + "\n");
  if (results.length !== limit || results.some((result) => result.error)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Video evaluation failed."}\n`);
  process.exitCode = 1;
});
