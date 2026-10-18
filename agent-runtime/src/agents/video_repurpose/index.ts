import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { estimateCostUsd } from "../../usage/cost.js";
import { probeDurationSec, sampleFrames } from "../video_edit/media.js";
import { hasAudioStream, transcribeSource, type Word } from "../source_video_edit/transcript.js";

const TOOL_NAME = "submit_repurpose_candidates";
const SCHEMA: Anthropic.Messages.Tool.InputSchema = {
  type: "object", additionalProperties: false, required: ["candidates"],
  properties: { candidates: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["kind", "title", "reason", "start_sec", "end_sec"], properties: {
      kind: { type: "string", enum: ["quote_image", "short_clip"] },
      title: { type: "string" }, reason: { type: "string" },
      start_sec: { type: "number" }, end_sec: { type: "number" },
    } } } },
};
type Request = { id: string; client_id: string; source_asset_id: string;
  direction: string; status: string };
export type Candidate = { kind: "quote_image" | "short_clip"; title: string;
  reason: string; start_sec: number; end_sec: number; exact_quote: string };

/** The quote comes only from transcribed source words inside the selected range. */
export function validateCandidates(raw: unknown, words: readonly Word[], duration: number): Candidate[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { candidates?: unknown }).candidates)) {
    throw new Error("Claude did not return repurpose candidates.");
  }
  const rows = (raw as { candidates: unknown[] }).candidates;
  if (rows.length < 1 || rows.length > 6) throw new Error("Choose one to six repurpose candidates.");
  const candidates: Candidate[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") throw new Error("A candidate is not an object.");
    const row = item as Record<string, unknown>;
    const start = row.start_sec, end = row.end_sec;
    if (row.kind !== "quote_image" && row.kind !== "short_clip") throw new Error("Unsupported derivative kind.");
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start)
      || !Number.isFinite(end) || start < 0 || end > duration + 0.1 || end <= start
      || end - start < (row.kind === "quote_image" ? 2 : 8)
      || end - start > (row.kind === "quote_image" ? 25 : 60)) {
      throw new Error("A candidate has an invalid source range.");
    }
    if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 120
      || typeof row.reason !== "string" || row.reason.length > 500) {
      throw new Error("A candidate needs a concise title and reason.");
    }
    const exact = words.filter((word) => (word.start + word.end) / 2 >= start
      && (word.start + word.end) / 2 <= end).map((word) => word.word).join(" ").trim();
    if (!exact) throw new Error("A candidate has no transcribed speech in its range.");
    candidates.push({ kind: row.kind, title: row.title.trim(), reason: row.reason.trim(),
      start_sec: start, end_sec: end, exact_quote: exact });
  }
  return candidates;
}

export async function runVideoRepurposeJob(sb: SupabaseClient, config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  const requestId = typeof job.params?.request_id === "string" ? job.params.request_id : null;
  if (!requestId || job.input_table !== "client_media_assets" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A source video and repurpose request are required." };
  }
  const { data: requestRow, error: requestError } = await sb.from("video_repurpose_requests")
    .select("*").eq("id", requestId).maybeSingle();
  if (requestError || !requestRow) return { ok: false, retryable: false,
    failureMessage: requestError?.message ?? "Repurpose request missing." };
  const request = requestRow as Request;
  if (request.source_asset_id !== job.input_id || request.client_id !== job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Repurpose source mismatch." };
  }
  if (request.status === "completed") return { ok: true, retryable: false };
  const { data: source, error: sourceError } = await sb.from("client_media_assets")
    .select("id, client_id, media_type, storage_path, render_path, review_status, edit_stage")
    .eq("id", request.source_asset_id).maybeSingle();
  if (sourceError || !source || source.client_id !== request.client_id || source.media_type !== "video"
      || source.review_status === "rejected" || source.edit_stage === "superseded") {
    return { ok: false, retryable: false, failureMessage: "This source video can no longer be repurposed." };
  }
  const { error: startError } = await sb.from("video_repurpose_requests")
    .update({ status: "running", error: null }).eq("id", request.id);
  if (startError) return { ok: false, retryable: false, failureMessage: startError.message };
  const work = await mkdtemp(join(tmpdir(), "video-repurpose-"));
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is needed to transcribe video for repurposing.");
    const path = source.render_path || source.storage_path;
    const { data: file, error: downloadError } = await sb.storage.from("client-media").download(path);
    if (downloadError || !file) throw new Error(`Could not download source video: ${downloadError?.message ?? "missing"}`);
    if (file.size > 500 * 1024 * 1024) throw new Error("Repurposing supports video files up to 500 MB.");
    const local = join(work, "source.mp4");
    await writeFile(local, Buffer.from(await file.arrayBuffer()));
    const duration = await probeDurationSec(local);
    if (duration > 15 * 60) throw new Error("Repurposing currently supports videos up to 15 minutes.");
    if (!await hasAudioStream(local)) throw new Error("This video has no audio to quote or clip.");
    const transcript = await transcribeSource(local, work, config.openaiApiKey, duration);
    if (transcript.words.length === 0) throw new Error("No spoken words were detected in this video.");
    usage.costUsd += Math.ceil(duration) / 60 * 0.006;
    await sb.from("video_repurpose_requests").update({ transcript }).eq("id", request.id);
    const frames = await sampleFrames(local, join(work, "frames"),
      { fps: Math.min(0.1, 12 / duration), width: 384 });
    const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: [
      `Source duration: ${duration.toFixed(1)}s.`, `Operator direction: ${request.direction || "Find the strongest useful moments."}`,
      "Choose one to six quote-image or short-clip candidates. Give exact source timestamps.",
      "Quote-image ranges: 2–25s. Short clips: 8–60s. Every range must contain spoken words.",
      "The renderer will derive the quote from transcript words; do not fabricate a quote.",
      "Transcript:", ...transcript.words.map((word) => `${word.start.toFixed(2)}-${word.end.toFixed(2)} ${word.word}`),
    ].join("\n") }];
    for (const frame of frames) {
      content.push({ type: "text", text: `Frame at ${frame.atSec.toFixed(1)}s` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg",
        data: frame.jpeg.toString("base64") } });
    }
    const client = new Anthropic({ ...(anthropicKeyForAgent(config, "video_repurpose_insights")
      ? { apiKey: anthropicKeyForAgent(config, "video_repurpose_insights") } : {}),
    maxRetries: 2, timeout: 180_000 });
    const response = await client.messages.stream({ model: config.model, max_tokens: 4000,
      system: `Find evidence-backed content opportunities in source footage. Use only the timed transcript and frames.
      Do not invent spoken quotes, facts, gestures, or scenes. A quote image becomes a new draft idea;
      a short clip becomes a new draft reel idea. Neither is approved or ready to distribute.
      Submit candidates with ${TOOL_NAME}.`,
      tool_choice: { type: "auto" }, tools: [{ name: TOOL_NAME,
        description: "Submit source-timestamped repurpose candidates.",
        input_schema: SCHEMA, strict: true } as Anthropic.Messages.ToolUnion],
      messages: [{ role: "user", content }],
    }).finalMessage();
    usage.inputTokens = response.usage.input_tokens;
    usage.outputTokens = response.usage.output_tokens;
    usage.costUsd += estimateCostUsd(config.model, { inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0 });
    const call = response.content.find((part): part is Anthropic.Messages.ToolUseBlock =>
      part.type === "tool_use" && part.name === TOOL_NAME);
    if (!call) throw new Error("Claude did not return repurpose candidates.");
    const candidates = validateCandidates(call.input, transcript.words, duration);
    const { error: completeError } = await sb.from("video_repurpose_requests")
      .update({ status: "completed", candidates, completed_at: new Date().toISOString(), error: null })
      .eq("id", request.id);
    if (completeError) throw new Error(completeError.message);
    await appendEvent(sb, job.id, `Found ${candidates.length} evidenced video derivative candidates.`);
    return { ok: true, retryable: false, usage };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await sb.from("video_repurpose_requests").update({ status: "failed", error: message.slice(0, 1000) })
      .eq("id", request.id);
    await appendEvent(sb, job.id, `Video repurpose failed: ${message}`, "error");
    return { ok: false, retryable: false, failureMessage: message, usage };
  } finally { await rm(work, { recursive: true, force: true }); }
}
