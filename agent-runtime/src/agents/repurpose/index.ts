// Repurposing Engine.
//
// One finished asset becomes briefs for the other formats it should exist in.
// A repurpose writes a BRIEF, not a file: AA cannot cut video, and a button
// that claimed to produce a reel would produce either nothing or a lie. The
// derivative brief then flows through Approve & Build or a dispatch exactly
// like an original, so no new production machinery exists to go stale.
//
// This runs after Brief Studio for a reason: a derivative is written from the
// root's hook and call to action, and those only became readable when briefs
// stopped being prose.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { briefSubmitTool, composeBody, briefColumns, fieldsFor } from "../brief/fields.js";
import { loadIdentity, identityWriterBlock } from "../identity.js";
import { resolveFormats, type RepurposeFormat } from "./formats.js";

const SYSTEM = `You work for Attract Acquisition. You take one finished, approved marketing asset and write the production brief for a different format of the same idea.

WHAT A REPURPOSE IS
Not a translation. The root asset already worked in its own format; your job is to find how the same argument earns attention in a format with different rules. A reel is not the static ad read aloud, and a carousel is not the reel's script cut into six.

WHAT CARRIES OVER, AND WHAT DOES NOT
- The claim and the proof carry over exactly. If the root made no proof claim, the derivative makes none either.
- The call to action carries over.
- The hook usually does NOT. A hook is format-specific: what stops a thumb on a reel is not what earns a swipe on frame one of a carousel. Write a new one and say why it suits this format.
- The brand's look carries over and is applied automatically; do not restate it.

ABSOLUTE RULES
- Invent nothing. No statistic, price, timeline, credential or customer quote that is not in what you were given.
- Never write a placeholder. The brief you write is read by the creative agents, so a gap left for someone to fill gets filled with something plausible and false.
- If the root genuinely does not work in the requested format, say so plainly in the premise and write the closest honest thing rather than forcing it.`;

async function writeOne(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
  format: RepurposeFormat,
  context: { rootTitle: string; rootBrief: string; identityBlock: string; assetId: string; clientId: string },
): Promise<{ ok: true; costUsd: number } | { ok: false; costUsd: number; message: string; retryable: boolean }> {
  const submitTool = briefSubmitTool(format.mediaType);

  const prompt = `Write the production brief for a ${format.label} derived from this finished asset.

WHAT THIS FORMAT MUST DO
${format.direction}

THE ROOT ASSET
${context.rootTitle}

THE BRIEF THE ROOT WAS MADE FROM — the claim, proof and action to carry over
${context.rootBrief}

${context.identityBlock}

THE FIELDS
${fieldsFor(format.mediaType).map(([name, description]) => `- ${name}: ${description}`).join("\n")}

Call ${submitTool.name} once when you are done.`;

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(config, agent.agent_key),
      model: config.model,
      timeoutMs: config.providerTimeoutMs,
      deadlineAt,
      system: SYSTEM,
      prompt,
      submitTool,
      enableWebSearch: false,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        costUsd: error.usage?.costUsd ?? 0,
        message: error.message,
        retryable: error.retryable,
      };
    }
    throw error;
  }

  const costUsd = result.usage.costUsd;
  const body = composeBody(format.mediaType, result.submitted);
  if (body.length < 200) {
    return { ok: false, costUsd, message: `The ${format.label} brief came back too thin.`, retryable: true };
  }

  const title = String(result.submitted.title ?? "").trim() || `${context.rootTitle} — ${format.label}`;
  const { error } = await sb.from("client_briefs").insert({
    client_id: context.clientId,
    title: title.slice(0, 300),
    body,
    ...briefColumns(format.mediaType, result.submitted),
    media_type: format.mediaType,
    status: "draft",
    job_id: job.id,
    derived_from_asset_id: context.assetId,
    repurpose_format: format.key,
  });
  if (error) throw new Error(`Failed to write the ${format.label} brief: ${error.message}`);

  return { ok: true, costUsd };
}

export async function runRepurposeJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A repurpose needs a client." };
  }
  if (job.input_table !== "client_media_assets" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent repurposes a finished asset — it has none to work from.",
    };
  }

  const { formats, unknown } = resolveFormats((job.params ?? {})["formats"]);
  if (formats.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: unknown.length
        ? `No format matched: ${unknown.join(", ")}.`
        : "No formats were requested.",
    };
  }

  const { data: asset } = await sb
    .from("client_media_assets")
    .select("id, title, media_type, review_status, brief_id")
    .eq("id", job.input_id)
    .maybeSingle();
  if (!asset) {
    return { ok: false, retryable: false, failureMessage: "That asset no longer exists." };
  }
  // Re-checked here as well as in the RPC: a job can sit in the queue while
  // someone changes their mind, and multiplying a rejected piece is the one
  // outcome this must not have.
  if (asset.review_status !== "approved") {
    return {
      ok: false,
      retryable: false,
      failureMessage: `Only an approved asset can be repurposed — this one is ${asset.review_status}.`,
    };
  }

  const { data: rootBrief } = asset.brief_id
    ? await sb.from("client_briefs").select("body").eq("id", asset.brief_id).maybeSingle()
    : { data: null };

  const { data: client } = await sb
    .from("clients")
    .select("name")
    .eq("id", job.client_id)
    .maybeSingle();
  const identity = await loadIdentity(sb, job.client_id, (client?.name as string) ?? "this business");

  const context = {
    rootTitle: String(asset.title ?? "Untitled"),
    // An asset uploaded outside the pipeline has no brief. Saying so beats
    // sending an empty section the model will quietly write around.
    rootBrief:
      (rootBrief?.body as string | undefined) ??
      "(no brief on file — this asset was uploaded rather than produced from one. Work from its title and the client's own material.)",
    identityBlock: identityWriterBlock(identity),
    assetId: String(asset.id),
    clientId: job.client_id,
  };

  await appendEvent(
    sb,
    job.id,
    `Repurposing "${context.rootTitle}" into ${formats.length} format${formats.length === 1 ? "" : "s"}: ${formats.map((f) => f.label).join(", ")}.`,
  );

  let costUsd = 0;
  const written: string[] = [];
  const failed: string[] = [];

  // Sequential on purpose. Each derivative is a full model turn, and the job
  // carries a deadline: firing them in parallel would spend the whole budget
  // at once and give the deadline nothing to stop.
  for (const format of formats) {
    const outcome = await writeOne(sb, config, agent, job, deadlineAt, format, context);
    costUsd += outcome.costUsd;
    if (outcome.ok) {
      written.push(format.label);
      await appendEvent(sb, job.id, `Wrote the ${format.label} brief.`, "info", { cost_usd: outcome.costUsd });
    } else {
      failed.push(`${format.label}: ${outcome.message}`);
      await appendEvent(sb, job.id, `Could not write the ${format.label} brief — ${outcome.message}`, "warn");
    }
  }

  const usage = { inputTokens: 0, outputTokens: 0, costUsd };

  // Partial success is success. Four briefs written and one refused is worth
  // keeping; failing the job would discard the four and retry all five.
  if (written.length === 0) {
    return {
      ok: false,
      retryable: true,
      failureMessage: `No derivative brief could be written. ${failed.join("; ")}`,
      usage,
    };
  }

  await appendEvent(
    sb,
    job.id,
    failed.length === 0
      ? `Wrote ${written.length} derivative brief${written.length === 1 ? "" : "s"}.`
      : `Wrote ${written.length}, could not write ${failed.length}: ${failed.join("; ")}`,
    failed.length === 0 ? "info" : "warn",
    { cost_usd: costUsd },
  );
  return { ok: true, retryable: false, usage };
}
