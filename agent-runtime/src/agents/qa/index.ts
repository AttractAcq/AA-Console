/**
 * The last gate before a person sees it.
 *
 * M3.9. A slot reaching `qa` has an asset and copy. This decides whether it
 * is fit to show somebody, and sends it back to be remade if not.
 *
 * No model. Every rule the build plan lists — brand, claims, platform, risk —
 * resolves to text and arithmetic, and a QA step whose verdict is a model's
 * opinion is one that gives a different answer to the same post on a second
 * run. The number decides whether a client's money is spent again, so it is
 * reproducible by construction.
 *
 * Two rebuilds, then stop. `content_slots.attempts` already counts a trip
 * round the loop; a third rebuild of something that has failed QA twice is a
 * third bill for the same answer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { logger } from "../../logging/logger.js";
import { loadSlot, type SlotContext } from "../../engine/slot.js";
import { isPlatform } from "../../content/platform-limits.js";
import { qaFindings, qaScore, qaSummary, type Finding } from "./checks.js";

/** How many times a slot may be sent back before QA gives up on it. */
export const MAX_QA_REBUILDS = 2;

/** Which stage a slot goes to, given its score and how often it has been round. */
export function nextStage(
  score: number,
  threshold: number,
  attempts: number,
  findings: readonly Finding[],
): { stage: "awaiting_approval" | "building" | "copywriting" | "failed"; note: string } {
  // A blocker blocks, whatever the arithmetic says. One banned phrase costs
  // 25 and leaves 75, which clears a threshold of 70 — so on score alone a
  // post saying the one thing the brand forbids would reach a person marked
  // "passed QA". The score measures how bad; this decides whether.
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  if (score >= threshold && blockers === 0) {
    return { stage: "awaiting_approval", note: `Passed QA at ${score}/100. ${qaSummary(findings)}` };
  }
  if (attempts >= MAX_QA_REBUILDS) {
    return {
      stage: "failed",
      note: `Still ${score}/100 after ${attempts} rebuild${attempts === 1 ? "" : "s"}. ${qaSummary(findings)}`,
    };
  }
  // Which half to send it back to. Everything QA can see about the asset is
  // its shape; everything else it found is in the words. Rebuilding an image
  // because a caption broke a rule spends the expensive half on the cheap
  // half's problem.
  const assetProblem = findings.some((f) => f.area === "platform" && /9:16|reel runs/.test(f.detail));
  return assetProblem
    ? { stage: "building", note: `${score}/100. The asset itself needs remaking. ${qaSummary(findings)}` }
    : { stage: "copywriting", note: `${score}/100. The words need rewriting. ${qaSummary(findings)}` };
}

export async function runQaJob(
  sb: SupabaseClient,
  _runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  let slot: SlotContext | null;
  try {
    slot = await loadSlot(sb, job);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (!slot) {
    return { ok: false, retryable: false, failureMessage: "QA only runs for a slot, and this job has none." };
  }
  if (!isPlatform(slot.platform)) {
    return {
      ok: false,
      retryable: false,
      failureMessage: `This slot is for "${slot.platform}", which has no rules on file.`,
    };
  }
  if (!slot.asset_id) {
    return { ok: false, retryable: false, failureMessage: "This slot has no asset for QA to look at." };
  }

  const [{ data: copyRow }, { data: brand }, { data: brief }, { data: asset }, proof, { data: settings }] =
    await Promise.all([
      sb
        .from("post_copy")
        .select("caption, hashtags, alt_text, link_url, first_comment, cta")
        .eq("asset_id", slot.asset_id)
        .eq("platform", slot.platform)
        .maybeSingle(),
      sb.from("client_brand_profiles").select("never_do").eq("client_id", slot.client_id).maybeSingle(),
      slot.brief_id
        ? sb
            .from("client_briefs")
            .select("title, hook, premise, argument, proof, call_to_action, script")
            .eq("id", slot.brief_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      sb.from("client_media_assets").select("width, height, duration_sec").eq("id", slot.asset_id).maybeSingle(),
      sb
        .from("client_proof_assets")
        .select("id", { count: "exact", head: true })
        .eq("client_id", slot.client_id),
      sb
        .from("client_engine_settings")
        .select("min_qa_score")
        .eq("client_id", slot.client_id)
        .maybeSingle(),
    ]);

  if (!copyRow) {
    // Copy is what QA mostly checks. Passing a slot with none would be
    // approving a post with no words.
    return {
      ok: false,
      retryable: false,
      failureMessage: `This slot has no ${slot.platform} copy for QA to check.`,
    };
  }

  const copy = copyRow as {
    caption: string | null;
    hashtags: string[] | null;
    alt_text: string | null;
    link_url: string | null;
    first_comment: string | null;
    cta: string | null;
  };

  const banned = String((brand as { never_do?: string } | null)?.never_do ?? "")
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const b = (brief ?? {}) as Record<string, string | null>;
  const briefText = ["title", "hook", "premise", "argument", "proof", "call_to_action", "script"]
    .map((key) => b[key] ?? "")
    .filter(Boolean)
    .join("\n");

  const dims = (asset ?? {}) as { width?: number | null; height?: number | null; duration_sec?: number | null };

  const findings = qaFindings({
    platform: slot.platform,
    format: slot.format,
    copy,
    bannedPhrases: banned,
    briefText,
    hasProof: (proof.count ?? 0) > 0,
    asset: { width: dims.width, height: dims.height, durationSec: dims.duration_sec },
  });

  const score = qaScore(findings);
  const threshold = Number((settings as { min_qa_score?: number } | null)?.min_qa_score ?? 70);
  const decision = nextStage(score, threshold, slot.attempts, findings);

  const { error } = await sb.rpc("record_qa_result", {
    p_slot_id: slot.id,
    p_score: score,
    p_findings: findings,
    p_to_stage: decision.stage,
    p_note: decision.note,
    p_job_id: job.id,
  } as never);
  if (error) throw new Error(`Could not record the QA result: ${error.message}`);

  await appendEvent(
    sb,
    job.id,
    `${score}/100. ${qaSummary(findings)} Sent to ${decision.stage.replace(/_/g, " ")}.`,
    findings.length > 0 ? "warn" : "info",
    { slot_id: slot.id, score, threshold, findings, to_stage: decision.stage },
  );
  logger.info("qa_checked", { jobId: job.id, slotId: slot.id, score, stage: decision.stage });

  void agent;
  return { ok: true, retryable: false };
}
