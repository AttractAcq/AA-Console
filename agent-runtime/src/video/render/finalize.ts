import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import { anthropicKeyForAgent } from "../../config.js";
import { buildVideoRenderInputs } from "./inputs.js";
import { reviewCodeVideoCandidate } from "./creative.js";
import type { VideoAspect } from "./probe.js";

type Candidate = { id: string; client_id: string; project_id: string;
  ir_version: number; aspect: VideoAspect; storage_path: string;
  file_sha256: string; file_bytes: number; probe_result: string;
  verdict: string; media_probe: { duration_sec?: number } };
type Dependencies = { prepare: typeof buildVideoRenderInputs;
  review: typeof reviewCodeVideoCandidate;
  download: typeof downloadCandidateExact };
const defaults: Dependencies = { prepare: buildVideoRenderInputs,
  review: reviewCodeVideoCandidate, download: downloadCandidateExact };
const HASH = /^[0-9a-f]{64}$/;

export class VideoCreativeReviewHeldError extends Error {}

/** Stream a private candidate to a restricted local file while comparing its
 * complete bytes with the committed candidate digest. No unverified MP4 is
 * passed to the paid visual critic.
 */
export async function downloadCandidateExact(input: { sb: SupabaseClient;
  candidate: Candidate; localPath: string }): Promise<void> {
  const { candidate } = input;
  if (!HASH.test(candidate.file_sha256)
    || !Number.isSafeInteger(candidate.file_bytes)
    || candidate.file_bytes <= 100) {
    throw new Error("Candidate byte receipt is invalid.");
  }
  const signed = await input.sb.storage.from("client-media")
    .createSignedUrl(candidate.storage_path, 3600);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("Private render candidate cannot be signed.");
  }
  const response = await fetch(signed.data.signedUrl,
    { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) {
    throw new Error("Private render candidate cannot be downloaded.");
  }
  const handle = await open(input.localPath, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > candidate.file_bytes) {
        throw new Error("Candidate download exceeds its byte receipt.");
      }
      digest.update(value);
      await handle.writeFile(value);
    }
    if (length !== candidate.file_bytes
      || digest.digest("hex") !== candidate.file_sha256) {
      throw new Error("Candidate download differs from its exact byte receipt.");
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close();
    await rm(input.localPath, { force: true });
    throw error;
  } finally { reader.releaseLock(); }
  await handle.close();
}

export function brandRules(value: Record<string, unknown> | null): string {
  if (!value) return "No reviewed brand profile is available.";
  const fields = ["colour_primary", "colour_secondary", "colour_accent",
    "colour_background", "colour_text", "font_heading", "font_body",
    "imagery_style", "never_do", "video_rulebook_notes"].map((key) =>
    `${key}: ${typeof value[key] === "string" && value[key] ? value[key] : "not recorded"}`)
    .join("; ");
  return `${fields}; video_tokens: ${JSON.stringify(value.video_tokens ?? {})}`;
}

/** Finish one exact IR version; no derivative or asset attachment occurs
 * unless the first aspect's paid visual decision has been filed.
 */
export async function finalizeVideoProjectRender(input: {
  sb: SupabaseClient; config: RuntimeConfig; clientId: string;
  projectId: string; jobId: string; irVersion: number;
  aspects: VideoAspect[]; candidateIds: ReadonlyMap<VideoAspect, string>;
  workDir: string; maxAlignmentLoss: number;
}, deps: Dependencies = defaults): Promise<{ state: "attached" | "rejected";
  assetId?: string }> {
  const firstAspect = input.aspects[0];
  const firstId = firstAspect && input.candidateIds.get(firstAspect);
  if (!firstAspect || !firstId || input.candidateIds.size !== input.aspects.length) {
    throw new Error("Exact first-aspect candidate set is incomplete.");
  }
  const firstResult = await input.sb.from("video_project_render_candidates_v1")
    .select("id,client_id,project_id,ir_version,aspect,storage_path,file_sha256,file_bytes,probe_result,verdict,media_probe")
    .eq("id", firstId).eq("client_id", input.clientId).maybeSingle();
  const candidate = firstResult.data as Candidate | null;
  if (firstResult.error || !candidate || candidate.id !== firstId
    || candidate.project_id !== input.projectId
    || candidate.ir_version !== input.irVersion
    || candidate.aspect !== firstAspect || candidate.probe_result !== "pass") {
    throw new Error("First render candidate differs from this exact project.");
  }
  if (candidate.verdict === "rejected") return { state: "rejected" };
  if (candidate.verdict === "pending") {
    const prepared = await deps.prepare({ sb: input.sb,
      clientId: input.clientId, projectId: input.projectId,
      maxAlignmentLoss: input.maxAlignmentLoss });
    if (prepared.irVersion !== input.irVersion
      || JSON.stringify(prepared.ir.aspects) !== JSON.stringify(input.aspects)) {
      throw new Error("Creative review source differs from the render IR.");
    }
    const timings: Array<{ sceneId: string; startSec: number;
      durationSec: number }> = [];
    let startSec = 0;
    prepared.timings.scenes.forEach((scene) => {
      timings.push({ sceneId: scene.id, startSec,
        durationSec: scene.durationSec });
      startSec += scene.durationSec;
    });
    if (!Number.isFinite(candidate.media_probe?.duration_sec)
      || Math.abs(startSec - Number(candidate.media_probe.duration_sec)) > 0.5) {
      throw new Error("Creative review timing differs from the physical MP4.");
    }
    const localPath = join(input.workDir, "creative-first.mp4");
    await deps.download({ sb: input.sb, candidate, localPath });
    const claim = await input.sb.rpc("claim_video_project_creative_v1", {
      p_candidate_id: candidate.id, p_job_id: input.jobId });
    const claimed = claim.data as { state?: string; attempt_id?: string } | null;
    if (claim.error || !claimed?.attempt_id) {
      throw new VideoCreativeReviewHeldError("Creative review claim is unavailable.");
    }
    if (claimed.state !== "claimed") {
      throw new VideoCreativeReviewHeldError(
        `Creative review attempt is ${claimed.state ?? "unknown"}; reconcile before another model call.`);
    }
    try {
      const review = await deps.review({ path: localPath,
        workDir: join(input.workDir, "creative-frames"), scenes: timings,
        narration: (prepared.ir.scenes as Array<typeof prepared.ir.scenes[number]
          & { narration: string }>).map((scene) => scene.narration).join("\n"),
        brandRules: brandRules(prepared.brandSnapshot),
        model: process.env.VIDEO_RENDER_REVIEW_MODEL?.trim() || input.config.model,
        apiKey: anthropicKeyForAgent(input.config, "video_render") });
      const finished = await input.sb.rpc("finish_video_project_creative_v1", {
        p_attempt_id: claimed.attempt_id, p_job_id: input.jobId,
        p_report: review, p_model: review.model,
        p_input_tokens: review.usage.inputTokens,
        p_output_tokens: review.usage.outputTokens,
        p_usd: review.usage.costUsd });
      if (finished.error || finished.data !== candidate.id) {
        throw new Error("Creative decision and cost could not be filed together.");
      }
      if (review.result === "fail") return { state: "rejected" };
    } catch {
      await input.sb.rpc("mark_video_project_creative_uncertain_v1", {
        p_attempt_id: claimed.attempt_id, p_job_id: input.jobId });
      throw new VideoCreativeReviewHeldError(
        "Creative review needs reconciliation; inspect the exact paid attempt.");
    }
  } else if (candidate.verdict !== "accepted") {
    throw new VideoCreativeReviewHeldError("Creative candidate verdict is unknown.");
  }
  for (const aspect of input.aspects.slice(1)) {
    const id = input.candidateIds.get(aspect);
    if (!id) throw new Error("A derivative candidate is absent.");
    const decision = await input.sb.rpc("decide_video_project_render_candidate_v1", {
      p_candidate_id: id, p_verdict: "accepted",
      p_creative_review: null, p_rejection_reason: null });
    if (decision.error || decision.data !== id) {
      throw new Error(`Derivative ${aspect} cannot inherit the first review.`);
    }
  }
  const attached = await input.sb.rpc("attach_video_project_render_v1", {
    p_project_id: input.projectId, p_first_candidate_id: candidate.id });
  if (attached.error || typeof attached.data !== "string") {
    throw new Error("Accepted video candidates could not enter human asset review.");
  }
  return { state: "attached", assetId: attached.data };
}
