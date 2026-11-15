/**
 * Campaign sweep.
 *
 * The notes: "one run driving every asset to ready-to-distribute by calling the
 * factories, each process individually".
 *
 * THIS IS A COMPOSER, NOT AN ENGINE
 *
 * The engine exists and runs: `create_workflow_run` already takes a campaign,
 * `add_workflow_agent_step` takes dependencies and chains one step's output
 * into the next, and `reconcile_workflow_runs` drives them every fifteen
 * seconds with `agent_jobs` still the only execution queue. It carries ten runs
 * and a hundred and forty steps of real work.
 *
 * So this writes a run and its steps and stops. It calls no model and spends
 * nothing, which is why it has no provider loop.
 *
 * WHY THE RUNTIME AND NOT AN RPC
 *
 * Both engine functions require `auth.role() = 'service_role'`. A definer
 * function does not change `auth.role()` — it reads the caller's JWT claim — so
 * a browser cannot compose a run however the function is declared. That is a
 * deliberate property of the engine. `request_campaign_sweep_v6` therefore
 * checks the gate and queues this agent, which composes as service_role.
 *
 * Route-aware sweeps also prepare plan-bound page and sales-agent drafts.
 * Those are internal artifacts; publishing and public enablement are separate.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { platformFor, sweepSteps, type SweepPiece } from "./plan.js";

/** How long a sweep's run has to finish before the engine calls it overdue. */
const DEADLINE_HOURS = 72;

export async function runCampaignSweepJob(
  sb: SupabaseClient,
  _config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  _deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A sweep runs for one client." };
  }
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "A sweep needs the campaign it is sweeping.",
    };
  }

  // Re-checked here rather than trusted from request time. 309 makes a plan
  // correctable, so the approval this sweep was asked for may have been
  // withdrawn in the minutes since.
  const { data: blocker, error: blockerError } = await sb.rpc("campaign_sweep_blocker_v6", {
    p_campaign_id: job.input_id,
  });
  if (blockerError) throw new Error(`Could not re-check the plan: ${blockerError.message}`);
  if (typeof blocker === "string" && blocker.length > 0) {
    // Not retryable: a withdrawn approval is a decision, not a transient fault,
    // and retrying would just re-read the same refusal.
    return { ok: false, retryable: false, failureMessage: blocker };
  }

  const { data: campaign, error: campaignError } = await sb
    .from("client_campaigns")
    .select("id, client_id, name, acquisition_mode, channels, content_count, organic_content_count, paid_content_count, content_spec_id, content_spec_hash, content_ideas_generated_at, plan_approved_fingerprint, needs_landing_page, needs_sales_agent, needs_lead_magnet")
    .eq("id", job.input_id)
    .maybeSingle();
  if (campaignError) throw new Error(`Campaign lookup failed: ${campaignError.message}`);
  if (!campaign) {
    return { ok: false, retryable: false, failureMessage: "That campaign no longer exists." };
  }
  const c = campaign as {
    id: string; client_id: string; name: string; acquisition_mode: string;
    channels: string[] | null; content_count: number;
    organic_content_count: number; paid_content_count: number;
    content_spec_id: string | null; content_spec_hash: string | null;
    content_ideas_generated_at: string | null;
    plan_approved_fingerprint: string | null;
    needs_landing_page: boolean; needs_sales_agent: boolean; needs_lead_magnet: boolean;
  };
  if (c.client_id !== job.client_id) {
    return { ok: false, retryable: false, failureMessage: "That campaign belongs to another client." };
  }

  // Pre-v7 approved route plans have no spec. Their original image sweep
  // remains readable and runnable; every newly approved route plan has a spec.
  let pieces: SweepPiece[] | undefined;
  let plannedIdeaIds: string[] | undefined;
  if (c.acquisition_mode !== "legacy" && c.content_spec_id) {
    if (!c.content_spec_hash) {
      return { ok: false, retryable: false, failureMessage: "The campaign's content requirements have no hash." };
    }
    const { data: spec, error: specError } = await sb.from("campaign_content_spec_versions_v7")
      .select("client_id, campaign_id, content_hash, pieces")
      .eq("id", c.content_spec_id).maybeSingle();
    if (specError) throw new Error(`Campaign content requirements could not be read: ${specError.message}`);
    if (!spec || spec.client_id !== c.client_id || spec.campaign_id !== c.id
      || spec.content_hash !== c.content_spec_hash || !Array.isArray(spec.pieces)) {
      return { ok: false, retryable: false, failureMessage: "The reviewed content requirements no longer match this campaign." };
    }
    if (spec.pieces.some((piece: { platform: string }) => piece.platform === "google_ads")) {
      return { ok: false, retryable: false, failureMessage: "Google search copy has no campaign sweep producer yet. Use the approved manual build sheet." };
    }
    if (spec.pieces.some((piece: { media_type: string; content_format: string }) =>
      piece.media_type === "video" && piece.content_format !== "reel")) {
      return { ok: false, retryable: false,
        failureMessage: "Video stories have no supported campaign sweep producer yet. Revise the plan or use a reel." };
    }
    pieces = spec.pieces as SweepPiece[];
    if (c.content_ideas_generated_at) {
      const { data: ids, error: bindError } = await sb.rpc("bind_campaign_planned_ideas_v7", {
        p_campaign_id: c.id,
      });
      if (bindError) {
        return { ok: false, retryable: false,
          failureMessage: `The saved campaign ideas do not match the reviewed plan: ${bindError.message}` };
      }
      if (!Array.isArray(ids) || ids.length !== c.content_count) {
        return { ok: false, retryable: false, failureMessage: "The reviewed campaign idea batch is incomplete." };
      }
      plannedIdeaIds = ids as string[];
    }
  }

  const platform = platformFor(c.channels);
  if (platform === null && !pieces) {
    // Composing a chain whose pieces have nowhere to go would fail at the end,
    // after paying for every idea and brief in it.
    return {
      ok: false,
      retryable: false,
      failureMessage: `This campaign's channels (${(c.channels ?? []).join(", ") || "none"}) name no platform a post can go to, so its content has no destination.`,
    };
  }

  // A legacy campaign has no route split, so its whole volume is one chain.
  // 308's columns are nought for legacy by design.
  const organicCount = c.acquisition_mode === "legacy" ? c.content_count : c.organic_content_count;
  const paidCount = c.acquisition_mode === "legacy" ? 0 : c.paid_content_count;
  const steps = sweepSteps({
    organicCount,
    paidCount,
    platform: platform ?? pieces?.[0]?.platform ?? "instagram",
    campaignId: c.id,
    pieces,
    plannedIdeaIds,
  });
  if (steps.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This plan divides into no pieces, so there is nothing to compose.",
    };
  }

  await appendEvent(
    sb,
    job.id,
    `Composing a sweep for ${c.name}: ${organicCount} organic and ${paidCount} paid piece${organicCount + paidCount === 1 ? "" : "s"}, ${steps.length} steps.`,
  );

  // A composer job can be retried after writing only part of its graph. Its
  // workflow deadline is an immutable part of the idempotency contract, so
  // reuse the first attempt's deadline rather than computing a new one.
  const { data: priorRun, error: priorRunError } = await sb.from("workflow_runs")
    .select("deadline_at").eq("client_id", c.client_id)
    .eq("kind", "campaign_sweep").eq("idempotency_key", job.id)
    .maybeSingle();
  if (priorRunError) throw new Error(`Could not inspect the prior sweep: ${priorRunError.message}`);

  // The job id as the idempotency key, so a retried job composes the same run
  // rather than a second one. create_workflow_run returns the existing run on
  // conflict and raises idempotency_conflict if anything about it differs.
  const { data: run, error: runError } = await sb.rpc("create_workflow_run", {
    p_client_id: c.client_id,
    p_kind: "campaign_sweep",
    p_workflow_version: c.acquisition_mode !== "legacy" ? "v7.sweep.2" : "v6.sweep.1",
    p_idempotency_key: job.id,
    p_input_snapshot: {
      campaign_id: c.id,
      organic_content_count: organicCount,
      paid_content_count: paidCount,
      target_platform: platform,
      content_spec_id: c.content_spec_id,
      content_spec_hash: c.content_spec_hash,
      planned_idea_ids: plannedIdeaIds ?? null,
      plan_fingerprint: c.plan_approved_fingerprint,
      needs_landing_page: c.needs_landing_page,
      needs_sales_agent: c.needs_sales_agent,
      ...(c.needs_lead_magnet ? { needs_lead_magnet: true } : {}),
    },
    p_deadline_at: priorRun?.deadline_at ?? new Date(Date.now() + DEADLINE_HOURS * 3_600_000).toISOString(),
    p_campaign_id: c.id,
    p_root_request_id: job.id,
    p_created_by: null,
  });
  if (runError) throw new Error(`Could not create the sweep run: ${runError.message}`);
  const runId = (run as { id?: string } | null)?.id;
  if (!runId) throw new Error("The sweep run was created without an id.");

  // In order: add_workflow_agent_step refuses a dependency that does not exist
  // yet, so the chain has to be written front to back.
  for (const step of steps) {
    const { error } = await sb.rpc("add_workflow_agent_step", {
      p_run_id: runId,
      p_step_key: step.stepKey,
      p_dependencies: step.dependencies,
      p_agent_key: step.agentKey,
      p_input_table: step.inputTable,
      p_input_id: step.inputId ?? (step.usesClientAsInput ? c.client_id : null),
      p_input_params: step.inputParams,
      p_input_from_step_key: step.inputFromStepKey,
    });
    if (error) throw new Error(`Could not add step ${step.stepKey}: ${error.message}`);
  }

  // Every route-aware piece gets a durable work record before the graph is
  // sealed. A retried composer sees the same package/version and the work-item
  // RPC rejects any changed input under the same identity.
  if (c.acquisition_mode !== "legacy") {
    const { data: packageRows, error: packageError } = await sb.rpc(
      "ensure_campaign_route_packages_v7", { p_campaign_id: c.id, p_run_id: runId },
    );
    if (packageError) throw new Error(`Could not version campaign routes: ${packageError.message}`);
    const packages = new Map((packageRows as Array<{ id: string; route: string; version: number }> | null ?? [])
      .map((row) => [row.route, row]));
    const plannedPieces: SweepPiece[] = pieces ?? [
      ...Array.from({ length: organicCount }, () => ({ route: "organic" as const,
        platform: platform ?? "instagram", media_type: "image" as const, content_format: "single" as const })),
      ...Array.from({ length: paidCount }, () => ({ route: "paid" as const,
        platform: platform ?? "instagram", media_type: "image" as const, content_format: "single" as const })),
    ];
    for (const [index, piece] of plannedPieces.entries()) {
      const routePackage = packages.get(piece.route);
      if (!routePackage) throw new Error(`No ${piece.route} route package was prepared.`);
      const pieceKey = `piece${index + 1}`;
      const finalStepKey = piece.media_type === "video" ? `${pieceKey}_edit` : `${pieceKey}_create`;
      const { data: work, error: workError } = await sb.rpc("create_delivery_work_item_v6", {
        p_campaign_id: c.id,
        p_route_package_id: routePackage.id,
        p_manifest_id: null,
        p_manifest_item_key: null,
        p_item_key: `content_${pieceKey}`,
        p_work_version: routePackage.version,
        p_owner_module: "content_production_factory",
        p_required: true,
        p_input_snapshot: {
          campaign_id: c.id,
          route_package_id: routePackage.id,
          content_spec_id: c.content_spec_id,
          content_spec_hash: c.content_spec_hash,
          piece_index: index + 1,
          piece,
          planned_idea_id: plannedIdeaIds?.[index] ?? null,
          workflow_run_id: runId,
        },
        p_expected_output: { artifact_kind: "asset", final_step_key: finalStepKey,
          route: piece.route, platform: piece.platform, media_type: piece.media_type,
          content_format: piece.content_format },
      });
      if (workError) throw new Error(`Could not record ${pieceKey}: ${workError.message}`);
      const workId = (work as { id?: string } | null)?.id;
      if (!workId) throw new Error(`${pieceKey} has no work item id.`);
      const { error: bindError } = await sb.rpc("bind_campaign_sweep_work_v7", {
        p_work_item_id: workId, p_run_id: runId,
        p_piece_key: pieceKey, p_final_step_key: finalStepKey,
      });
      if (bindError) throw new Error(`Could not bind ${pieceKey} to its final step: ${bindError.message}`);
    }

    const { data: draft, error: draftError } = await sb.rpc(
      "ensure_campaign_conversion_drafts_v7", { p_campaign_id: c.id, p_run_id: runId },
    );
    if (draftError) throw new Error(`Could not prepare conversion drafts: ${draftError.message}`);
    const conversion = draft as { page_id: string | null; page_work_item_id: string | null;
      sales_agent_id: string | null; sales_work_item_id: string | null } | null;
    if (!conversion) throw new Error("Conversion preparation returned no draft record.");
    if (c.needs_landing_page) {
      if (!conversion.page_id || !conversion.page_work_item_id)
        throw new Error("The required campaign page draft is missing.");
      const { error: pageStepError } = await sb.rpc("add_workflow_agent_step", {
        p_run_id: runId, p_step_key: "conversion_page", p_dependencies: [],
        p_agent_key: "landing_page", p_input_table: "client_pages",
        p_input_id: conversion.page_id, p_input_params: {}, p_input_from_step_key: null,
      });
      if (pageStepError) throw new Error(`Could not add campaign page work: ${pageStepError.message}`);
      const { error: pageBindError } = await sb.rpc("bind_campaign_conversion_work_v7", {
        p_work_item_id: conversion.page_work_item_id, p_run_id: runId,
        p_step_key: "conversion_page",
      });
      if (pageBindError) throw new Error(`Could not bind campaign page work: ${pageBindError.message}`);
    }
    if (c.needs_sales_agent) {
      if (!conversion.sales_agent_id || !conversion.sales_work_item_id)
        throw new Error("The required sales-agent draft is missing.");
      const { error: agentStepError } = await sb.rpc("add_workflow_agent_step", {
        p_run_id: runId, p_step_key: "conversion_sales_agent",
        p_dependencies: c.needs_landing_page ? ["conversion_page"] : [],
        p_agent_key: "sales_agent", p_input_table: "client_sales_agents",
        p_input_id: conversion.sales_agent_id, p_input_params: {}, p_input_from_step_key: null,
      });
      if (agentStepError) throw new Error(`Could not add sales-agent work: ${agentStepError.message}`);
      const { error: agentBindError } = await sb.rpc("bind_campaign_conversion_work_v7", {
        p_work_item_id: conversion.sales_work_item_id, p_run_id: runId,
        p_step_key: "conversion_sales_agent",
      });
      if (agentBindError) throw new Error(`Could not bind sales-agent work: ${agentBindError.message}`);
    }
  }
  const { error: sealError } = await sb.rpc("seal_workflow_run", { p_run_id: runId });
  if (sealError) throw new Error(`Could not seal the campaign sweep: ${sealError.message}`);

  const totalSteps = steps.length + (c.acquisition_mode !== "legacy"
    ? Number(c.needs_landing_page) + Number(c.needs_sales_agent) : 0);

  await appendEvent(
    sb,
    job.id,
    `Swept ${c.name} into ${totalSteps} sealed steps. The reconciler drives them from here; nothing distributes without its own approval.`,
    "info",
    { run_id: runId, steps: totalSteps, organic: organicCount, paid: paidCount },
  );

  return { ok: true, retryable: false };
}
