// Creative build: an approved brief becomes an actual asset.
//
// Two stages, deliberately separate.
//
// Stage one writes the CONCEPT — what the asset actually is. A brief says
// what the business needs; a renderer needs to be told what to draw. Handing
// a business brief straight to an image model produces something that looks
// like a stock photo of the industry, because that is all the brief
// described. So the concept is written first, stored, and is the thing worth
// editing and re-running.
//
// Stage two renders it. For text briefs there is nothing to render — the
// concept IS the deliverable — so stage one writes the copy and stops.
//
// Video never reaches here. It is human work, and the database rejects an
// AI video generation outright rather than relying on the UI to hide it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { OpenAiError, runStructuredCompletion } from "../../tools/openai.js";
import { estimateCostUsd } from "../../usage/cost.js";
import { renderContext, renderUpstream } from "../shared.js";
import { loadConceptContext } from "./context.js";
import type { BusinessContext } from "../shared.js";
import { RenderError, estimateImageCostUsd, renderImage, type ReferenceImage } from "./render.js";
import { placeLogo } from "./logo.js";
import { brandConceptBlock, brandRenderBlock, loadBrandProfile, type BrandProfile } from "./brand.js";

const BUCKET = "client-media";

interface BriefRow {
  id: string;
  client_id: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  brief_ref: string | null;
}

const IMAGE_CONCEPT_TOOL = {
  name: "submit_concept",
  description: "Submit the creative concept for this asset. Call once.",
  inputSchema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "The largest words on the asset. Empty string if it carries no text." },
      subhead: { type: "string", description: "Supporting line, or an empty string." },
      call_to_action: { type: "string", description: "The action asked for, or an empty string." },
      subject: { type: "string", description: "Who or what is literally in frame." },
      composition: { type: "string", description: "Layout, crop, where the text sits, where the eye goes first." },
      art_direction: { type: "string", description: "Palette, lighting, mood, texture, photographic or graphic treatment." },
      avoid: { type: "string", description: "What must not appear: cliches for this sector, anything off-brand, anything unprovable." },
      rationale: { type: "string", description: "Why this concept serves the brief. For the operator, not the renderer." },
    },
    required: ["headline", "subhead", "call_to_action", "subject", "composition", "art_direction", "avoid", "rationale"],
    additionalProperties: false,
  },
};

const TEXT_CONCEPT_TOOL = {
  name: "submit_copy",
  description: "Submit the finished copy for this brief. Call once.",
  inputSchema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "The opening line." },
      body: { type: "string", description: "The full copy, ready to publish, in the client's voice." },
      call_to_action: { type: "string", description: "The action asked for." },
      rationale: { type: "string", description: "Why this lands, for the operator." },
    },
    required: ["headline", "body", "call_to_action", "rationale"],
    additionalProperties: false,
  },
};

const SYSTEM = `You are the creative director for Attract Acquisition, a marketing agency.

You are given an approved brief and the client's own intelligence. You decide what the asset actually is.

WHAT YOU ARE DOING
A brief states what the business needs. A renderer needs to be told what to make. Your job is that translation, and it is the whole reason this step exists — an image model handed a business brief produces a stock photo of the industry, because that is all it was given.

RULES
- Be specific and literal about what is in frame. "Professional imagery" is not a concept. "A dentist in her forties, mid-conversation with a patient, natural window light from camera left" is.
- Only reference proof or claims that appear in what you were given. Never invent a statistic, a testimonial, or a credential — this asset goes in front of the public.
- Respect the brand voice. If it says never to say something, never say it.
- Say what to avoid, including the visual cliche this sector is drowning in.
- Write for the buyer described in the ICP, not for a marketing audience.

NEVER WRITE A PLACEHOLDER INTO TEXT THAT WILL BE RENDERED
Anything you put in headline, subhead or call_to_action is set as literal type on the image. A renderer handed "[the practice's phone number]" or "practice name as it appears on the door" does not leave a gap — it invents a plausible name and a plausible number, and the result looks finished and is false.
So: only write words you were actually given. If a phone number, address, price, URL or handle is not in the material above, do not refer to it at all — leave that element out. The business name you may use is the one named in the brief and nowhere else.`;

export interface Identity {
  phone: string | null;
  website: string | null;
  instagram: string | null;
  address: string | null;
  hasLogo: boolean;
}

/**
 * Each detail is either given verbatim or explicitly forbidden. There is no
 * third state: a renderer told nothing about a phone number will invent a
 * plausible one, which is how the first live build put a fabricated WhatsApp
 * number on a real practice's advertising.
 */
function identityLines(identity: Identity): string[] {
  const rule = (label: string, value: string | null, ban: string) =>
    value
      ? `${label} is exactly "${value}". Render it verbatim, character for character, or leave it out. Never alter or substitute it.`
      : ban;

  return [
    rule("The contact number", identity.phone, "No contact number is on file. Do NOT render a phone or WhatsApp number of any kind."),
    rule("The website", identity.website, "No website is on file. Do NOT render a URL or domain."),
    rule("The Instagram handle", identity.instagram, "No social handle is on file. Do NOT render one."),
    rule("The address", identity.address, "No address is on file. Do NOT render a street, suburb or city."),
    // A diffusion model approximates a wordmark, and an approximated logo is
    // still the wrong mark, so the real file is placed afterwards.
    identity.hasLogo
      ? "A real logo will be placed into this image afterwards. Leave a clean empty area at the foot, roughly 15% of the height, with nothing in it — no lettering, no shape, no placeholder mark."
      : "Do NOT draw a logo, wordmark, monogram, badge or emblem of any kind.",
  ];
}

function composePrompt(
  concept: Record<string, unknown>,
  brief: BriefRow,
  clientName: string,
  identity: Identity,
  brand: BrandProfile | null,
): string {
  const s = (k: string) => String(concept[k] ?? "").trim();
  const text = [s("headline"), s("subhead"), s("call_to_action")].filter(Boolean);

  return [
    `Create a finished, production-ready marketing image.`,
    ``,
    `SUBJECT`,
    s("subject"),
    ``,
    `COMPOSITION`,
    s("composition"),
    ``,
    `ART DIRECTION`,
    s("art_direction"),
    ``,
    // After art_direction on purpose: the concept's own words come first, and
    // the brand's literal values follow so they win any disagreement.
    brandRenderBlock(brand),
    text.length
      ? `\nTEXT ON THE IMAGE — render these words exactly, spelled correctly, in this hierarchy:\n${text.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : `\nNo text on the image.`,
    ``,
    `DO NOT INCLUDE`,
    s("avoid") || "Stock-photo cliche, watermarks, distorted hands or faces, unreadable lettering.",
    ``,
    // The concept stage is told not to emit placeholders, but a renderer
    // will invent an identity from nothing if the composition implies one —
    // it produced a fabricated practice name, logo and phone number before
    // this block existed. The asset goes in front of the public, so the ban
    // is repeated where the pixels are actually made.
    `IDENTITY — THIS IS A REAL BUSINESS, DO NOT INVENT ANY PART OF IT`,
    `The business is "${clientName}". That is the only name that may appear.`,
    ...identityLines(identity),
    `Do NOT invent or render any detail not listed above — no other business name, no price, no review score, no email.`,
    `Blank space is correct; an invented detail is a false claim on a real company's advertising.`,
    ``,
    `This is a paid marketing asset for ${clientName}. It must look deliberate, not generated.`,
  ].join("\n");
}

export async function runCreativeBuildJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "A creative build needs a client." };
  }
  const params = (job.params ?? {}) as Record<string, unknown>;
  const renderId = typeof params.render_id === "string" ? params.render_id : null;
  if (!renderId) {
    return { ok: false, retryable: false, failureMessage: "No render to produce." };
  }

  const { data: render, error: renderError } = await sb
    .from("creative_renders")
    .select("id, generation_id, quality, size, reference_path")
    .eq("id", renderId)
    .maybeSingle();
  if (renderError) throw new Error(`Could not load the render: ${renderError.message}`);
  if (!render) {
    return { ok: false, retryable: false, failureMessage: "That render no longer exists." };
  }

  const generationId = render.generation_id as string;
  const { data: generation, error: genError } = await sb
    .from("creative_generations")
    .select("id, brief_id, media_type, quality, size, concept, stage, reference_path")
    .eq("id", generationId)
    .maybeSingle();
  if (genError) throw new Error(`Could not load the generation: ${genError.message}`);
  if (!generation) {
    return { ok: false, retryable: false, failureMessage: "That build no longer exists." };
  }

  // The render carries its own settings, so a re-render at a different
  // quality does not rewrite the generation the earlier ones used.
  const renderQuality = String(render.quality);
  const renderSize = String(render.size);
  const renderReference = render.reference_path as string | null;

  // The one difference between a first build and a re-render.
  const existingConcept = generation.concept as Record<string, unknown> | null;
  const needsConcept = !existingConcept || Object.keys(existingConcept).length === 0;

  const { data: brief, error: briefError } = await sb
    .from("client_briefs")
    .select("id, client_id, title, body, media_type, brief_ref")
    .eq("id", generation.brief_id)
    .maybeSingle();
  if (briefError) throw new Error(`Could not load the brief: ${briefError.message}`);
  if (!brief) return { ok: false, retryable: false, failureMessage: "That brief no longer exists." };

  const typed = brief as BriefRow;
  if (typed.media_type === "video") {
    return {
      ok: false,
      retryable: false,
      failureMessage: "Video is produced by people. Send this brief to an editor or avatar instead.",
    };
  }

  const isImage = typed.media_type === "image";

  // Check the renderer before writing a concept. An image build that cannot
  // render is worth failing for free rather than after paying for the
  // expensive half — which is exactly what it used to do.
  if (isImage && !config.openaiApiKey) {
    const message =
      "No image renderer is configured. Set OPENAI_API_KEY on the runtime to enable AI image builds.";
    await sb
      .from("creative_generations")
      .update({ stage: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", generationId);
    await sb.from("client_briefs").update({ status: "approved" }).eq("id", typed.id);
    return { ok: false, retryable: false, failureMessage: message };
  }
  if (config.conceptProvider === "openai" && !config.openaiApiKey) {
    const message =
      "The creative concept is set to run on OpenAI but no OPENAI_API_KEY is configured. Set the key, or set CREATIVE_CONCEPT_PROVIDER=anthropic.";
    await sb
      .from("creative_generations")
      .update({ stage: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", generationId);
    await sb.from("client_briefs").update({ status: "approved" }).eq("id", typed.id);
    return { ok: false, retryable: false, failureMessage: message };
  }
  const fail = async (message: string) => {
    await sb
      .from("creative_renders")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", renderId);
    await sb
      .from("creative_generations")
      .update({ stage: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", generationId);
    // Hand the brief back only if nothing has ever come out of it. A
    // re-render failing must not undo a build that already produced an
    // asset and moved the brief on.
    const { count } = await sb
      .from("creative_renders")
      .select("id", { count: "exact", head: true })
      .eq("generation_id", generationId)
      .eq("status", "done");
    if (!count) {
      await sb.from("client_briefs").update({ status: "approved" }).eq("id", typed.id);
    }
  };

  // ---- stage one: the concept -------------------------------------------
  await appendEvent(
    sb,
    job.id,
    needsConcept
      ? `Writing the creative concept for "${typed.title}".`
      : `Re-rendering "${typed.title}".`,
  );

  const [{ data: client }, { data: contact }, { data: context }, upstream, brand] = await Promise.all([
    sb.from("clients").select("name").eq("id", job.client_id).maybeSingle(),
    sb
      .from("client_contact_details")
      .select("phone, whatsapp, website, instagram, address, logo_path")
      .eq("client_id", job.client_id)
      .maybeSingle(),
    sb
      .from("client_business_context")
      .select("business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue")
      .eq("client_id", job.client_id)
      .maybeSingle(),
    // Selected sections, not whole domains — see context.ts.
    loadConceptContext(sb, job.client_id),
    loadBrandProfile(sb, job.client_id),
  ]);

  // The renderer is given the real values so it never has to guess one.
  const clientName = (client?.name as string | undefined) ?? "this business";
  const c = (contact ?? {}) as Record<string, string | null>;
  const identity = {
    phone: c.whatsapp || c.phone || null,
    website: c.website || null,
    instagram: c.instagram || null,
    address: c.address || null,
    hasLogo: Boolean(c.logo_path),
  };
  // The select above is the only source of these; a silent typo there would
  // read as "nothing on file" and quietly go back to blank corners.
  const onFile = Object.entries(identity).filter(([, v]) => v).map(([k]) => k);

  const { data: proofRows } = await sb
    .from("client_proof_assets")
    .select("title, body, source")
    .eq("client_id", job.client_id)
    .limit(15);
  const proof = (proofRows ?? [])
    .map((p) => `- ${p.title ?? "Untitled"}${p.source ? ` (${p.source})` : ""}: ${p.body ?? "[file]"}`)
    .join("\n");

  const hasReference = Boolean(renderReference);
  const submitTool = isImage ? IMAGE_CONCEPT_TOOL : TEXT_CONCEPT_TOOL;
  const prompt = `Turn this approved brief into ${isImage ? "a creative concept for a single image" : "finished copy"}.
${
  hasReference
    ? `\nA REFERENCE IMAGE HAS BEEN SUPPLIED and the render will start from it. Write the concept as DIRECTION ON THAT IMAGE — what to keep, what to change, what to add, how to treat it — not as a description of a picture to build from nothing. Do not describe a subject that would replace it.\n`
    : ""
}

THE BRIEF
${typed.title}

${typed.body ?? "(no detail beyond the title)"}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

ICP, BRAND AND OFFER
${renderUpstream(upstream)}

${brandConceptBlock(brand)}

PROOF ON FILE — the only proof this asset may reference
${proof || "None. Make no proof claim."}

IDENTITY ON FILE — the only identity details that exist
Business name: ${clientName}
${onFile.length === 0
  ? "Nothing else. Do not refer to a phone number, website, handle, address or logo at all — none exist, and a placeholder becomes an invention when it is rendered."
  : `On file and safe to use: ${onFile.join(", ")}. Anything not in that list does not exist — do not refer to it.`}

Call ${submitTool.name} once when you are done.`;

  let concept: Record<string, unknown>;
  let usage: { inputTokens: number; outputTokens: number; costUsd: number } = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const conceptModel =
    config.conceptProvider === "openai" ? config.conceptModel : config.model;

  if (!needsConcept) {
    // The whole reason renders are separate rows: this is the expensive
    // half, and iterating on the same direction must not pay for it again.
    concept = existingConcept as Record<string, unknown>;
    await appendEvent(
      sb,
      job.id,
      "Reusing the existing concept — no reasoning cost for this render.",
    );
  } else try {
    if (config.conceptProvider === "openai") {
      const out = await runStructuredCompletion({
        apiKey: config.openaiApiKey as string,
        model: config.conceptModel,
        system: SYSTEM,
        prompt,
        schemaName: submitTool.name,
        schema: submitTool.inputSchema,
        reasoningEffort: "medium",
      });
      concept = out.parsed;
      usage = {
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        costUsd: estimateCostUsd(config.conceptModel, out.usage),
      };
    } else {
      const out = await runAgentLoop({
        apiKey: anthropicKeyForAgent(config, agent.agent_key),
        model: config.model,
      timeoutMs: config.providerTimeoutMs,
        system: SYSTEM,
        prompt,
        submitTool,
        enableWebSearch: false,
        onProgress: (note) => void appendEvent(sb, job.id, note),
      });
      concept = out.submitted;
      usage = {
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        costUsd: out.usage.costUsd,
      };
    }
  } catch (error) {
    if (error instanceof ProviderError || error instanceof OpenAiError) {
      await fail(error.message);
      return { ok: false, retryable: error.retryable, failureMessage: error.message };
    }
    throw error;
  }

  await sb
    .from("creative_renders")
    .update({ status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", renderId);

  // ---- text stops here: the concept is the deliverable -------------------
  if (!isImage) {
    const body = String(concept.body ?? "").trim();
    if (body.length < 40) {
      const message = "The copy came back too thin to use.";
      await fail(message);
      return { ok: false, retryable: true, failureMessage: message, usage };
    }

    const path = `${job.client_id}/generated/${renderId}.md`;
    const document = [`# ${String(concept.headline ?? typed.title)}`, "", body, "", `**Call to action:** ${String(concept.call_to_action ?? "")}`].join("\n");
    const { error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(path, Buffer.from(document, "utf8"), { contentType: "text/markdown", upsert: true });
    if (uploadError) throw new Error(`Could not store the copy: ${uploadError.message}`);

    const assetId = await insertAsset(sb, job, typed, path, "text");
    await sb
      .from("creative_renders")
      .update({
        status: "done",
        asset_id: assetId,
        model: conceptModel,
        cost_usd: usage.costUsd,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", renderId);
    await sb
      .from("creative_generations")
      .update({
        stage: "done",
        concept,
        concept_model: conceptModel,
        asset_id: assetId,
        cost_usd: usage.costUsd,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", generationId);

    await markBriefComplete(sb, typed.id);
    await appendEvent(sb, job.id, "Copy written and filed under the client's assets.");
    return { ok: true, retryable: false, usage };
  }

  // ---- stage two: render -------------------------------------------------
  const imagePrompt = composePrompt(concept, typed, clientName, identity, brand);
  await sb
    .from("creative_generations")
    .update({
      stage: "render",
      concept,
      image_prompt: imagePrompt,
      concept_model: conceptModel,
      image_model: config.imageModel,
      cost_usd: usage.costUsd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", generationId);

  await appendEvent(sb, job.id, `Rendering at ${renderQuality} quality, ${renderSize}.`);

  let reference: ReferenceImage | null = null;
  if (renderReference) {
    const { data: file, error: downloadError } = await sb.storage
      .from(BUCKET)
      .download(renderReference);
    if (downloadError || !file) {
      const message = `Could not read the reference image: ${downloadError?.message ?? "not found"}`;
      await fail(message);
      return { ok: false, retryable: false, failureMessage: message, usage };
    }
    const name = renderReference.split("/").pop() ?? "reference.png";
    reference = {
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "image/png",
      filename: name,
    };
    await appendEvent(sb, job.id, `Working from the supplied reference image (${name}).`);
  }

  let image;
  try {
    image = await renderImage(config, imagePrompt, {
      size: renderSize,
      quality: renderQuality,
      reference,
    });
  } catch (error) {
    if (error instanceof RenderError) {
      // The concept survives a render failure on purpose: it is the
      // expensive half, and a retry should not pay for it twice.
      await fail(error.message);
      return { ok: false, retryable: error.retryable, failureMessage: error.message, usage };
    }
    throw error;
  }

  // The render left a clear band at the foot; the real logo goes into it
  // here rather than being drawn by the model.
  let final = { bytes: image.bytes, contentType: image.contentType, extension: image.extension };
  if (c.logo_path) {
    const { data: logoFile, error: logoError } = await sb.storage.from(BUCKET).download(c.logo_path);
    if (logoError || !logoFile) {
      // Not fatal: the render is paid for and still worth keeping.
      await appendEvent(
        sb,
        job.id,
        `Could not read the logo (${logoError?.message ?? "not found"}) — filed without it.`,
        "warn",
      );
    } else {
      const { result, placed, reason } = await placeLogo(
        image.bytes,
        Buffer.from(await logoFile.arrayBuffer()),
      );
      final = result;
      await appendEvent(
        sb,
        job.id,
        placed ? "Placed the client's logo onto the render." : `Logo not placed: ${reason}`,
        placed ? "info" : "warn",
      );
    }
  }

  const path = `${job.client_id}/generated/${renderId}.${final.extension}`;
  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(path, final.bytes, { contentType: final.contentType, upsert: true });
  if (uploadError) throw new Error(`Could not store the image: ${uploadError.message}`);

  const assetId = await insertAsset(sb, job, typed, path, "image");
  await sb
    .from("creative_renders")
    .update({
      status: "done",
      asset_id: assetId,
      model: config.imageModel,
      // Concept cost lands on the render that paid for it; every render also
      // carries its own image cost. A re-render therefore reads as the few
      // cents it actually cost, not as free.
      cost_usd: usage.costUsd + estimateImageCostUsd(renderQuality),
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", renderId);
  await sb
    .from("creative_generations")
    .update({ stage: "done", asset_id: assetId, error: null, updated_at: new Date().toISOString() })
    .eq("id", generationId);

  await markBriefComplete(sb, typed.id);
  await appendEvent(
    sb,
    job.id,
    needsConcept
      ? "Image rendered and filed under the client's assets, awaiting review."
      : "Re-render complete, filed alongside the earlier ones.",
  );
  return { ok: true, retryable: false, usage };
}

/** Lands in the same table as anything a person uploaded, pending review. */
async function insertAsset(
  sb: SupabaseClient,
  job: AgentJobRow,
  brief: BriefRow,
  path: string,
  mediaType: "image" | "text",
): Promise<string> {
  const { data, error } = await sb
    .from("client_media_assets")
    .insert({
      client_id: job.client_id,
      brief_id: brief.id,
      media_type: mediaType,
      title: brief.title,
      storage_path: path,
      review_status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not file the asset: ${error.message}`);
  return data.id as string;
}

async function markBriefComplete(sb: SupabaseClient, briefId: string): Promise<void> {
  await sb.from("client_briefs").update({ status: "complete" }).eq("id", briefId);
}
