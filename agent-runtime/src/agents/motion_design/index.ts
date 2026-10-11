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
import { motionCanvas, motionCapability, motionPalette, renderMotion, validateMotionPlan, type MotionAspect } from "./render.js";

const BUCKET = "client-media";
const TOOL_NAME = "submit_motion_scenes";
const MOTION_MODEL = process.env.MOTION_DESIGN_MODEL?.trim() || "claude-opus-5";
const SCHEMA: Anthropic.Messages.Tool.InputSchema = {
  type: "object", additionalProperties: false, required: ["scenes"],
  properties: { scenes: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["duration_sec", "background", "elements"],
    properties: {
      duration_sec: { type: "number" }, background: { type: "string" },
      elements: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["kind", "x", "y", "color", "at_sec", "enter"],
        properties: {
          kind: { type: "string", enum: ["text", "rect", "circle", "line"] },
          x: { type: "number" }, y: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
          from_x: { type: "number" }, from_y: { type: "number" }, enter_duration_sec: { type: "number" },
          width: { type: "number" }, height: { type: "number" }, radius: { type: "number" },
          size: { type: "number" }, text: { type: "string" }, weight: { type: "number" },
          align: { type: "string", enum: ["start", "middle", "end"] },
          color: { type: "string" }, stroke: { type: "string" }, stroke_width: { type: "number" },
          at_sec: { type: "number" },
          enter: { type: "string", enum: ["none", "fade", "rise", "slide_left", "slide_right", "scale", "draw", "move"] },
          motion: { type: "string", enum: ["still", "float", "pulse"] },
        },
      } },
    } } } },
};
type Project = { id: string; client_id: string; prompt: string; preset: string;
  aspect: MotionAspect; duration_sec: number; brand_mode: string; status: string;
  revision_of: string | null };

async function askScenes(config: RuntimeConfig, project: Project, brandNotes: string,
  correction?: string): Promise<{ raw: unknown; usage: { inputTokens: number; outputTokens: number; costUsd: number } }> {
  const client = new Anthropic({ ...(anthropicKeyForAgent(config, "motion_design")
    ? { apiKey: anthropicKeyForAgent(config, "motion_design") } : {}),
  maxRetries: 2, timeout: 180_000 });
  const canvas = motionCanvas(project.aspect);
  const response = await client.messages.stream({ model: MOTION_MODEL, max_tokens: 12000,
    system: `You are a senior motion designer making a finished, polished motion graphic from the user's own prompt.
    Art-direct the entire composition and timing. Do not reduce the request to generic title cards.
    Use shapes, typography, lines, spatial hierarchy, sequencing, and animation to SHOW the requested idea.
    Each element is authored by you: text, rectangle, circle, or line. Coordinates are on a ${canvas.width}×${canvas.height} canvas.
    Multiple elements can appear at different at_sec times in each scene. A line with enter=draw reveals progressively.
    Put words in separate text elements when they need distinct placement or timing. Keep them readable and within canvas.
    Colour is a brand token (background, primary, accent, text, surface) or a six-digit hex colour.
    Motion choices are none, fade, rise, slide_left, slide_right, scale, draw and move for entering; still, float or pulse for continuous motion.
    To move an object across the canvas, set enter=move, final x/y, initial from_x/from_y, and enter_duration_sec. Give a card's rectangle and label the same movement so they stay together.
    The supplied prompt is the creative brief. Preserve its visual metaphor, exact meaningful copy, and intended use.
    If the creative brief explicitly names colours, use those colours in the design even when the brand guidance differs. Brand colours are a fallback for colours the brief does not specify.
    Do not invent metrics, client proof, logos, footage, audio, or unsupported effects.
    Submit only the fully designed scene plan through the tool.`,
    tool_choice: { type: "tool", name: TOOL_NAME }, tools: [{ name: TOOL_NAME,
      description: "Submit a fully designed motion graphic with individually placed and timed visual elements.",
      input_schema: SCHEMA } as Anthropic.Messages.ToolUnion],
    messages: [{ role: "user", content: [
      `Create a ${project.preset} motion design, ${project.aspect}, exactly ${project.duration_sec} seconds.`,
      `Creative brief (highest priority for composition and colours): ${project.prompt}`,
      `Brand guidance (fallback where the creative brief is silent): ${brandNotes || "None supplied."}`,
      `Canvas: ${canvas.width}×${canvas.height} coordinates. Use 1 to 5 scenes, 1 to 12 seconds each, with total duration ${project.duration_sec}. Each scene may have up to 40 elements.`,
      `For text, set text and size (12–140). For rect, set width and height; radius is optional. For circle, set radius. For line, set x2 and y2; stroke_width is optional. Set x, y, color, at_sec and enter on every element.`,
      `When the brief calls for objects to move into place, use enter=move with from_x, from_y, and enter_duration_sec (0.1 to scene duration). Keep linked shapes and text synchronized.`,
      `Use a deliberate composition with enough visual detail and animation to explain the subject. Include a clear beginning, visual development, and ending. Avoid repeating one layout.`,
      project.preset === "hero" ? "Use exactly one scene and make movement return smoothly to its starting position so it loops." : "Keep on-screen copy concise, but do not omit the visual mechanism the user requested.",
      correction ? `Fix this validation problem: ${correction}` : "",
    ].join("\n") }],
  }).finalMessage();
  const usage = { inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd: estimateCostUsd(MOTION_MODEL, { inputTokens: response.usage.input_tokens,
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
      ? `Colours: background ${palette.background}, primary ${palette.primary}, accent ${palette.accent}, text ${palette.text}, surface #FFFFFF. Mood: ${brand?.mood ?? "not specified"}. Never do: ${brand?.never_do ?? "not specified"}.`
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
