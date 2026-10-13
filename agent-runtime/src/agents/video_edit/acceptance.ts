import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProviderError } from "../../tools/anthropic.js";
import { estimateCostUsd, type TokenUsage } from "../../usage/cost.js";
import { sampleFrames } from "./media.js";

const run = promisify(execFile);

export interface MediaProbe {
  result: "pass" | "fail";
  width: number;
  height: number;
  duration_sec: number;
  has_audio: boolean;
  audio_mean_db: number | null;
  black_intervals: Array<{ start_sec: number; end_sec: number }>;
  checks: string[];
}

export interface CreativeReview {
  result: "pass" | "fail";
  checks: Array<{ area: string; verdict: "pass" | "fail"; reason: string; at_sec: number | null }>;
  summary: string;
  model: string;
  sampled_fps: number;
  usage: TokenUsage & { costUsd: number };
}

export function missingReviewAreas(raw: Record<string, unknown>): string[] {
  const checks = Array.isArray(raw.checks) ? raw.checks as Array<Record<string, unknown>> : [];
  return AREAS.filter((area) => checks.filter((check) => check.area === area
    && (check.verdict === "pass" || check.verdict === "fail")
    && typeof check.reason === "string" && check.reason.trim().length > 0).length !== 1);
}

/** Inspect the actual exported file, rather than trusting the EDL's intended dimensions. */
export async function probeRenderedVideo(path: string, requireAudio = false): Promise<MediaProbe> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration",
    "-of", "json", path,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(parsed.format?.duration);
  const width = Number(video?.width ?? 0);
  const height = Number(video?.height ?? 0);
  const hasAudio = Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio"));
  const checks: string[] = [];
  if (!requireAudio && hasAudio) checks.push("Captions-only export unexpectedly contains audio.");
  let audioMeanDb: number | null = null;
  if (requireAudio && !hasAudio) checks.push("The requested soundtrack is missing from the export.");
  if (requireAudio && hasAudio) {
    const { stderr: audioLog } = await run("ffmpeg", [
      "-hide_banner", "-nostats", "-i", path, "-af", "volumedetect",
      "-vn", "-f", "null", "-",
    ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    const match = audioLog.match(/mean_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB/);
    audioMeanDb = match && match[1] !== "-inf" ? Number(match[1]) : null;
    if (audioMeanDb === null || audioMeanDb < -45) {
      checks.push("The requested soundtrack is silent or too quiet to verify.");
    }
  }
  if (width !== 1080 || height !== 1920) checks.push(`Expected 1080x1920; got ${width}x${height}.`);
  if (!Number.isFinite(duration) || duration < 3 || duration > 90) {
    checks.push(`Invalid reel duration: ${duration}s.`);
  }
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path, "-vf", "blackdetect=d=0.15:pix_th=0.10",
    "-an", "-f", "null", "-",
  ], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  const blackIntervals = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
    .map((match) => ({ start_sec: Number(match[1]), end_sec: Number(match[2]) }))
    .filter((interval) => Number.isFinite(interval.start_sec) && Number.isFinite(interval.end_sec));
  if (blackIntervals.length > 0) checks.push(`${blackIntervals.length} black interval(s) detected.`);
  return {
    result: checks.length === 0 ? "pass" : "fail",
    width, height, duration_sec: Number(duration.toFixed(3)),
    has_audio: hasAudio, audio_mean_db: audioMeanDb, black_intervals: blackIntervals, checks,
  };
}

const AREAS = ["continuity", "visual_defects", "caption_readability", "crop", "narrative", "brand_fit"] as const;
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    checks: {
      type: "array",
      items: { type: "object", properties: {
        area: { type: "string", enum: [...AREAS] },
        verdict: { type: "string", enum: ["pass", "fail"] },
        reason: { type: "string" },
        at_sec: { type: ["number", "null"] },
      }, required: ["area", "verdict", "reason", "at_sec"], additionalProperties: false },
    },
  },
  required: ["result", "summary", "checks"], additionalProperties: false,
} as const;

/** A model-led screen across the final cut; owner/SMM approval remains separate. */
export async function reviewRenderedVideo(input: {
  path: string; workDir: string; brief: string; brandNeverDo: string;
  soundTreatment: "audio_present" | "captions_only";
}, options: { model: string; timeoutMs?: number; apiKey?: string }): Promise<CreativeReview> {
  const frameDir = join(input.workDir, "final-review");
  await mkdir(frameDir, { recursive: true });
  const frames = await sampleFrames(input.path, frameDir, { fps: 1, width: 512 });
  if (frames.length < 3) throw new Error("Too few final-cut frames for a visual review.");
  const content: Anthropic.Messages.ContentBlockParam[] = [{
    type: "text",
    text: [
      "Review the actual final vertical reel from time-ordered frames. This is an internal quality screen before human approval.",
      "Fail for cast/product/location drift, visual artefacts, clipped or unreadable captions, bad crop, weak or incoherent narrative, or off-brand imagery.",
      "Check every listed area. Cite the timestamp for a visible defect. Do not claim to have heard audio or seen motion between sampled frames.",
      `Sound treatment recorded by the media probe: ${input.soundTreatment}.`,
      `Brand restrictions: ${input.brandNeverDo || "none recorded"}.`,
      `Brief: ${input.brief}`,
    ].join("\n"),
  }];
  for (const frame of frames) {
    content.push({ type: "text", text: `Final cut at ${frame.atSec.toFixed(2)} seconds:` });
    content.push({ type: "image", source: {
      type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64"),
    } });
  }
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    maxRetries: 2, timeout: options.timeoutMs ?? 600_000,
  });
  let spent: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let correction = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.stream({
        model: options.model, max_tokens: 4096,
        system: "You are a rigorous creative director screening a finished video. Submit an honest verdict with exactly one substantive check for each of: continuity, visual_defects, caption_readability, crop, narrative, brand_fit.",
        tool_choice: { type: "tool", name: "submit_video_review" },
        tools: [{ name: "submit_video_review", description: "Submit final-cut quality review.",
          input_schema: REVIEW_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
          strict: true } as Anthropic.Messages.ToolUnion],
        messages: [{ role: "user", content: correction
          ? [...content, { type: "text", text: correction }] : content }],
      } as Anthropic.Messages.MessageStreamParams).finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        const status = error.status ?? 0;
        throw new ProviderError(`Anthropic ${status}: ${error.message}`, status === 429 || status === 408 || status >= 500,
          { ...spent, costUsd: estimateCostUsd(options.model, spent) });
      }
      throw new ProviderError(error instanceof Error ? error.message : String(error), true,
        { ...spent, costUsd: estimateCostUsd(options.model, spent) });
    }
    spent = {
      inputTokens: spent.inputTokens + response.usage.input_tokens,
      outputTokens: spent.outputTokens + response.usage.output_tokens,
      cacheReadTokens: (spent.cacheReadTokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: (spent.cacheWriteTokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
    };
    const call = response.content.find((block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === "submit_video_review");
    const raw = (call?.input ?? {}) as Record<string, unknown>;
    const checks = Array.isArray(raw.checks) ? raw.checks as CreativeReview["checks"] : [];
    const missing = missingReviewAreas(raw);
    if (call && (raw.result === "pass" || raw.result === "fail")
        && typeof raw.summary === "string" && raw.summary.trim()
        && checks.length === AREAS.length && missing.length === 0) {
      const result = checks.some((check) => check.verdict === "fail") ? "fail" : raw.result;
      return { result, summary: raw.summary, checks, model: response.model, sampled_fps: 1,
        usage: { ...spent, costUsd: estimateCostUsd(options.model, spent) } };
    }
    correction = `The prior response was incomplete. Review all six areas exactly once; missing or invalid: ${missing.join(", ") || "verdict or summary"}. Submit the tool response again.`;
  }
  throw new ProviderError("The creative review omitted a required quality check after three review calls.", false,
    { ...spent, costUsd: estimateCostUsd(options.model, spent) });
}
