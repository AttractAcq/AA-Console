/**
 * Ask a model for an EDL.
 *
 * One request, no tools but the submit tool. The model sees the brief and
 * sampled stills from each clip, each labelled with its time inside the clip,
 * and answers through submit_edit_plan. A revise call sends the previous plan
 * and every validation problem back in the same shape.
 *
 * The model is a parameter so Opus and Fable can be compared on the same
 * reels. Spend is priced with the runtime's own cost table.
 */

import Anthropic from "@anthropic-ai/sdk";

import { ProviderError } from "../../tools/anthropic.js";
import { unsupportedStrictKeywords } from "../../tools/schema.js";
import { estimateCostUsd, type TokenUsage } from "../../usage/cost.js";
import { EDL_SCHEMA, parseEdl, type Edl } from "./edl.js";

export const SUBMIT_TOOL_NAME = "submit_edit_plan";

export interface PlanClip {
  shot: number;
  beat: string;
  duration_sec: number;
  shot_source_kind: string;
  frames: ReadonlyArray<{ atSec: number; jpeg: Buffer }>;
}

export interface PlanInput {
  title: string;
  briefText: string;
  maxTotalSec: number;
  bannedPhrases: readonly string[];
  clips: readonly PlanClip[];
  revise?: { edl: Edl; problems: readonly string[] } | null;
}

export interface PlanResult {
  edl: Edl;
  usage: TokenUsage & { costUsd: number };
  model: string;
}

export const SYSTEM = `You are the editor for short vertical social video (Reels, TikTok).
You are given a brief and stills sampled from each generated clip, labelled with the time inside that clip.
Cut the clips into one reel that delivers the brief:
- The hook lands in the first two seconds. Open on the strongest frame, not the first one.
- Cut on movement where you can see it. Drop frames that warp, smear or show artefacts.
- Captions say what the brief says. Never add a figure, claim or promise the brief does not make.
- One idea per caption, short enough to read in the time it is on screen.
- End on the call to action from the brief as an end card, or no end card if the brief has none.
Submit the plan with ${SUBMIT_TOOL_NAME}. Put your reasons in notes for the human who approves it.`;

/** The user turn. Exported so tests can check what the model is shown. */
export function buildPlanContent(input: PlanInput): Anthropic.Messages.ContentBlockParam[] {
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  const banned = input.bannedPhrases.filter((p) => p.trim());
  content.push({
    type: "text",
    text: [
      `Reel: ${input.title}`,
      `Maximum length including any end card: ${input.maxTotalSec}s.`,
      banned.length ? `The brand never uses: ${banned.join("; ")}.` : "The brand has no banned phrases on file.",
      "",
      "BRIEF",
      input.briefText.trim(),
    ].join("\n"),
  });

  for (const clip of input.clips) {
    const proof = clip.shot_source_kind === "source_asset" ? " Client footage: cut only, no crossfade." : "";
    content.push({
      type: "text",
      text: `SHOT ${clip.shot}: ${clip.beat}. Clip length ${clip.duration_sec.toFixed(2)}s.${proof}`,
    });
    for (const frame of clip.frames) {
      content.push({ type: "text", text: `Shot ${clip.shot} at ${frame.atSec.toFixed(2)}s` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64") },
      });
    }
  }

  if (input.revise) {
    content.push({
      type: "text",
      text: [
        "Your previous plan could not be rendered. Fix every problem below and submit the whole plan again.",
        ...input.revise.problems.map((problem) => `- ${problem}`),
        "",
        "Previous plan:",
        JSON.stringify(input.revise.edl),
      ].join("\n"),
    });
  }
  return content;
}

export async function planEdit(
  input: PlanInput,
  options: { apiKey?: string; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; timeoutMs?: number },
): Promise<PlanResult> {
  const unsupported = unsupportedStrictKeywords(EDL_SCHEMA);
  if (unsupported.length > 0) {
    throw new ProviderError(`The EDL schema uses ${unsupported.join(", ")}, which strict tools reject.`, false);
  }
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    maxRetries: 2,
    timeout: options.timeoutMs ?? 600_000,
  });

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages
      .stream({
        model: options.model,
        max_tokens: 32000,
        system: SYSTEM,
        output_config: { effort: options.effort ?? "high" },
        // Forced tool_choice is refused on current models: auto plus the
        // instruction in SYSTEM, and the missing-call check below.
        tool_choice: { type: "auto" },
        tools: [
          {
            name: SUBMIT_TOOL_NAME,
            description: "Submit the edit decision list for this reel.",
            input_schema: EDL_SCHEMA as Anthropic.Messages.Tool.InputSchema,
            strict: true,
          } as Anthropic.Messages.ToolUnion,
        ],
        messages: [{ role: "user", content: buildPlanContent(input) }],
      } as Anthropic.Messages.MessageStreamParams)
      .finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const status = error.status ?? 0;
      throw new ProviderError(`Anthropic ${status}: ${error.message}`, status === 429 || status >= 500 || status === 408);
    }
    throw new ProviderError(error instanceof Error ? error.message : String(error), true);
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  const priced = { ...usage, costUsd: estimateCostUsd(options.model, usage) };

  if (response.stop_reason === "refusal") {
    throw new ProviderError("The model declined to plan this edit.", false, priced);
  }
  const call = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use" && block.name === SUBMIT_TOOL_NAME,
  );
  if (!call) {
    throw new ProviderError(`The model answered without calling ${SUBMIT_TOOL_NAME}.`, true, priced);
  }
  const parsed = parseEdl(call.input);
  if (!parsed.ok) throw new ProviderError(parsed.problem, true, priced);
  return { edl: parsed.edl, usage: priced, model: response.model };
}
