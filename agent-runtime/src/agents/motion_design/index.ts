import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import { anthropicKeyForAgent } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { estimateCostUsd } from "../../usage/cost.js";
import { motionCapability, motionPalette, renderMotion, validateMotionPlan, type MotionAspect } from "./render.js";

const BUCKET = "client-media";
const TOOL_NAME = "submit_motion_scenes";
const SCHEMA: Anthropic.Messages.Tool.InputSchema = {
  type: "object", additionalProperties: false, required: ["scenes"],
  properties: { scenes: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["duration_sec", "headline", "body", "motif", "motion"],
    properties: {
      duration_sec: { type: "number" }, headline: { type: "string" }, body: { type: "string" },
      motif: { type: "string", enum: ["orbit", "bars", "cards"] },
      motion: { type: "string", enum: ["rise", "slide", "pulse"] },
    } } } },
};
type Project = { id: string; client_id: string; prompt: string; preset: string;
  aspect: MotionAspect; duration_sec: number; brand_mode: string; status: string;
  revision_of: string | null };

async function askScenes(config: RuntimeConfig, project: Project, brandNotes: string,
  correction?: string): Promise<{ raw: unknown; usage: { inputTokens: number; outputTokens: number; costUsd: number } }> {
  const client = new Anthropic({ ...(anthropicKeyForAgent(config, "motion_design")
    ? { apiKey: anthropicKeyForAgent(config, "motion_design") } : {}),
  maxRetries: 2, timeout: 120_000 });
  const response = await client.messages.stream({ model: config.model, max_tokens: 4000,
    system: `You are a motion designer. Produce short, tasteful typography and abstract-shape scenes.
    The renderer supports orbit, bars, or cards motifs and rise, slide, or pulse motion only.
    Do not claim to create characters, footage, voiceover, 3D, or arbitrary effects.
    Keep headlines legible and make the on-screen copy factual. Submit only the scene plan.
    A hero is one seamless pulse scene with very little copy.`,
    tool_choice: { type: "auto" }, tools: [{ name: TOOL_NAME,
      description: "Submit bounded motion scenes for the controlled renderer.",
      input_schema: SCHEMA, strict: true } as Anthropic.Messages.ToolUnion],
    messages: [{ role: "user", content: [
      `Create a ${project.preset} motion design, ${project.aspect}, exactly ${project.duration_sec} seconds.`,
      `User request: ${project.prompt}`, `Brand guidance: ${brandNotes || "None supplied."}`,
      `Use 1 to 5 scenes. Each scene is 1 to 12 seconds; total duration must equal ${project.duration_sec}.`,
      project.preset === "hero" ? "Use exactly one pulse scene; it must loop naturally." : "Use concise on-screen copy.",
      correction ? `Fix this validation problem: ${correction}` : "",
    ].join("\n") }],
  }).finalMessage();
  const usage = { inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd: estimateCostUsd(config.model, { inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0 }) };
  const call = response.content.find((part): part is Anthropic.Messages.ToolUseBlock =>
    part.type === "tool_use" && part.name === TOOL_NAME);
  if (!call) throw new Error("Claude did not return a motion scene plan.");
  return { raw: call.input, usage };
}

export async function runMotionDesignJob(sb: SupabaseClient, config: RuntimeConfig,
  _agent: AgentRow, job: AgentJobRow): Promise<JobResult> {
  if (job.input_table !== "motion_design_projects" || !job.input_id || !job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A motion design project is required." };
  }
  const { data, error } = await sb.from("motion_design_projects").select("*")
    .eq("id", job.input_id).maybeSingle();
  if (error || !data) return { ok: false, retryable: false,
    failureMessage: error?.message ?? "Motion design project missing." };
  const project = data as Project;
  if (project.client_id !== job.client_id) return { ok: false, retryable: false,
    failureMessage: "Motion design client mismatch." };
  if (project.status === "completed") return { ok: true, retryable: false };
  const { error: startError } = await sb.from("motion_design_projects")
    .update({ status: "running", error: null }).eq("id", project.id);
  if (startError) return { ok: false, retryable: false, failureMessage: startError.message };
  const workDir = await mkdtemp(join(tmpdir(), "motion-design-"));
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const capability = await motionCapability();
    if (capability) throw new Error(capability);
    const { data: brand } = await sb.from("client_brand_profiles")
      .select("colour_background, colour_primary, colour_accent, colour_text, mood, never_do")
      .eq("client_id", project.client_id).maybeSingle();
    const palette = motionPalette(project.brand_mode === "on_brand" ? {
      background: brand?.colour_background, primary: brand?.colour_primary,
      accent: brand?.colour_accent, text: brand?.colour_text,
    } : {});
    const brandNotes = project.brand_mode === "on_brand"
      ? `Mood: ${brand?.mood ?? "not specified"}. Never do: ${brand?.never_do ?? "not specified"}.`
      : "Use a clean neutral treatment.";
    let planned = await askScenes(config, project, brandNotes);
    usage = planned.usage;
    let plan;
    try { plan = validateMotionPlan(planned.raw, project.duration_sec, project.preset); }
    catch (validationError) {
      planned = await askScenes(config, project, brandNotes,
        validationError instanceof Error ? validationError.message : String(validationError));
      usage = { inputTokens: usage.inputTokens + planned.usage.inputTokens,
        outputTokens: usage.outputTokens + planned.usage.outputTokens,
        costUsd: usage.costUsd + planned.usage.costUsd };
      plan = validateMotionPlan(planned.raw, project.duration_sec, project.preset);
    }
    await sb.from("motion_design_projects").update({ scene_plan: plan }).eq("id", project.id);
    await appendEvent(sb, job.id, `Planned ${plan.scenes.length} motion scenes.`);
    const output = join(workDir, "motion.mp4");
    const poster = join(workDir, "poster.jpg");
    const result = await renderMotion(plan, { aspect: project.aspect, palette,
      workDir, outputPath: output, posterPath: poster });
    const renderPath = `${project.client_id}/motion-design/${project.id}/motion.mp4`;
    const posterPath = `${project.client_id}/motion-design/${project.id}/poster.jpg`;
    const { error: videoError } = await sb.storage.from(BUCKET).upload(renderPath,
      await readFile(output), { upsert: true, contentType: "video/mp4" });
    if (videoError) throw new Error(`Could not store motion video: ${videoError.message}`);
    const { error: posterError } = await sb.storage.from(BUCKET).upload(posterPath,
      await readFile(poster), { upsert: true, contentType: "image/jpeg" });
    if (posterError) throw new Error(`Could not store motion poster: ${posterError.message}`);
    const { error: completeError } = await sb.from("motion_design_projects")
      .update({ status: "completed", scene_plan: plan, render_path: renderPath,
        poster_path: posterPath, completed_at: new Date().toISOString(), error: null })
      .eq("id", project.id);
    if (completeError) throw new Error(completeError.message);
    await appendEvent(sb, job.id, `Motion design rendered: ${result.durationSec}s, ${result.width}×${result.height}.`);
    return { ok: true, retryable: false, usage };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await sb.from("motion_design_projects").update({ status: "failed", error: message.slice(0, 1000) })
      .eq("id", project.id);
    await appendEvent(sb, job.id, `Motion design failed: ${message}`, "error");
    return { ok: false, retryable: false, failureMessage: message, usage };
  } finally { await rm(workDir, { recursive: true, force: true }); }
}
