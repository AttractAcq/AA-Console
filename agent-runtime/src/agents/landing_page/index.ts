// Landing / offer page agent.
//
// The Build Page form has been enqueueing jobs for this agent with no
// runner behind them — a click produced a job that failed
// NO_RUNTIME_IMPLEMENTATION. This is that runner.
//
// Not a record agent: the output is one page, not a set of templated
// sections, so it writes back to the client_pages row the form created.
// Gated on offer_strategy — a page selling an offer nobody has defined is
// just copy.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords, renderContext, renderUpstream } from "../shared.js";
import type { BusinessContext } from "../shared.js";
import { loadPagePackage, renderPackage } from "./aggregate.js";
import { pageProblem, recruitmentPageProblem } from "./safety.js";

const PAGE_KIND: Record<string, string> = {
  landing: "a primary landing page — the main page traffic is sent to, carrying the core offer",
  offer: "a secondary offer page — a focused page for one specific offer, usually reached from elsewhere",
  recruitment:
    "a hiring page — where a recruitment ad sends somebody who is deciding whether to apply for a job at Attract Acquisition",
};

/**
 * What a hiring page has to do that a selling page does not.
 *
 * Without this the agent writes a conversion page: it takes the offer strategy
 * and the ICP it is handed, and produces marketing aimed at the businesses AA
 * sells to. That is exactly what happened to the hiring ADS before the same
 * fix landed in creative_build — a good page for the wrong reader.
 */
const RECRUITMENT_BLOCK = `THIS IS A HIRING PAGE, NOT A SELLING PAGE

The reader is a person deciding whether to apply for a job. They are not a business deciding whether to buy, and nothing on this page is being sold to them.

So the page must say, at the top and in plain words, that Attract Acquisition is hiring and for what. A visitor who cannot tell within one screen that this is a job advert has been sent to the wrong page.

WHAT IT HAS TO COVER
- What the work actually is, day to day. Not "join our dynamic team".
- Who it suits, and — just as usefully — who it does not. A page that puts off the wrong applicant has done half the job.
- What happens next: how to apply, and what to expect after applying.

THE OFFER STRATEGY AND ICP BELOW DESCRIBE WHO AA SELLS TO
They are context for what the work involves — whose accounts this person would handle — and they are NOT the audience for this page. Do not write to them.

NEVER INVENT ANY OF THIS
A salary, a day rate, a benefit, a start date, an office location, a team size, or how many people applied. If the brief does not state it, the page does not mention it. A candidate who accepts on the strength of an invented number finds out at the offer stage, and that is AA's problem to have caused.`;

export async function runLandingPageJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Page jobs require a client." };
  }
  if (job.input_table !== "client_pages" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent builds a page created by Build Page — it has no page to work on.",
    };
  }

  const { data: page, error: pageError } = await sb
    .from("client_pages")
    .select("id, page_type, title, brief, reference_asset_id")
    .eq("id", job.input_id)
    .maybeSingle();
  if (pageError) throw new Error(`Failed to load page: ${pageError.message}`);
  if (!page) {
    return { ok: false, retryable: false, failureMessage: "That page no longer exists." };
  }
  if (!page.brief || page.brief.trim().length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "The page has no brief. Say what the page is for and try again.",
    };
  }

  const { data: clientRow } = await sb
    .from("clients")
    .select("name")
    .eq("id", job.client_id)
    .maybeSingle();
  const clientName = (clientRow?.name as string | undefined) ?? "this business";

  const [{ data: context }, records] = await Promise.all([
    sb
      .from("client_business_context")
      .select(
        "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
      )
      .eq("client_id", job.client_id)
      .maybeSingle(),
    loadUpstreamRecords(sb, job.client_id, ["offer_strategy", "icp", "brand_strategy"]),
  ]);

  const offer = records.filter((r) => r.domain === "offer_strategy");
  if (offer.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "No offer strategy exists for this client. Run the Offer Strategist first.",
    };
  }

  // Everything the business knows, gathered behind one button. A landing page
  // is the single worst place to invent a claim, because it is the page a
  // regulator or a disappointed customer reads back to you — so identity and
  // proof arrive with the same discipline the creative stages use.
  const [pkg, { data: brandRow }] = await Promise.all([
    loadPagePackage(sb, job.client_id, clientName),
    sb
      .from("client_brand_profiles")
      .select("custom_css")
      .eq("client_id", job.client_id)
      .maybeSingle(),
  ]);
  const packageBlock = renderPackage(pkg, (brandRow?.custom_css as string | null) ?? null);

  const submitTool = {
    name: "submit_page",
    description: "Submit the finished page. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Internal title for this page." },
        headline: { type: "string", description: "The main headline a visitor reads first." },
        subheadline: { type: "string", description: "The line under the headline." },
        primary_cta: { type: "string", description: "The primary call to action button text." },
        meta_title: { type: "string", description: "What a browser tab and a search result show. Under 60 characters." },
        meta_description: { type: "string", description: "The search-result snippet. Under 155 characters, written to earn the click." },
        html: {
          type: "string",
          description:
            "The complete page as a single self-contained HTML document: <!doctype html> through </html>, with all CSS in one <style> block in the head. No external stylesheets, no frameworks, no <script>. Responsive down to 360px.",
        },
      },
      required: ["title", "headline", "subheadline", "primary_cta", "meta_title", "meta_description", "html"],
      additionalProperties: false,
    },
  };

  const kind = PAGE_KIND[page.page_type] ?? PAGE_KIND.landing;
  const isRecruitment = page.page_type === "recruitment";

  // The ad somebody clicked to get here. A page whose headline argues
  // something different from the creative that sent them reads as the wrong
  // page, however good it is on its own.
  let adBlock = "";
  if (page.reference_asset_id) {
    const { data: asset } = await sb
      .from("client_media_assets")
      .select("title, ref_number, brief_id")
      .eq("id", page.reference_asset_id)
      .maybeSingle();
    if (asset) {
      const { data: adBrief } = asset.brief_id
        ? await sb
            .from("client_briefs")
            .select("hook, script, call_to_action")
            .eq("id", asset.brief_id)
            .maybeSingle()
        : { data: null };
      adBlock = [
        "",
        "THE AD THIS PAGE IS THE DESTINATION FOR",
        "Somebody reaching this page has just read the words below. Continue that argument — do not restate it, and do not contradict it.",
        `Creative: ${String(asset.title ?? asset.ref_number ?? "untitled")}`,
        adBrief?.hook ? `Headline they saw: ${adBrief.hook}` : null,
        adBrief?.script ? `Body they saw: ${adBrief.script}` : null,
        adBrief?.call_to_action ? `Button they pressed: ${adBrief.call_to_action}` : null,
        "",
      ]
        .filter((line) => line !== null)
        .join("\n");
    }
  }

  const system = `You write conversion pages for Attract Acquisition, a marketing agency.

You are writing ${kind}.
${isRecruitment ? `\n${RECRUITMENT_BLOCK}\n` : ""}

WHAT MAKES THIS PAGE WORK
- The headline earns the next line, and every line earns the one after it. A visitor who stops reading has been failed by the previous sentence, not by their attention span.
- Lead with what the buyer wants, not with who the business is. "About us" is not a headline.
- Handle the real objections from the ICP, in the order they occur to the reader. An unhandled objection does not go away, it just becomes a silent exit.
- One primary action. Repeat it; do not compete with it.

ABSOLUTE RULES
- Only reference proof you were actually given. If there is none, write a page that works without a proof claim and say so at the end of your body under a "Gaps" heading — do not invent a statistic, a testimonial, a customer, a guarantee or a credential. This is the page a regulator or a disappointed customer reads back to you.
- Respect anything the offer strategy lists as a limit or a thing that cannot be promised. Those are hard constraints, not preferences.
- Match the brand voice you are given. If it says never to say something, never say it.
- Write in the buyer's language, taken from the ICP, not in marketing register.

BUILDING THE PAGE
You return one self-contained HTML document. All styling goes in a single <style> block in the head.
- No external stylesheets, no CDN, no framework, no web fonts fetched over the network. A page that cannot render offline is a page that renders differently for the client than for you.
- No <script> of any kind. This page is previewed inside the agency's own console; a page that executes is a page that can act on whoever opens it.
- No tracking pixels, no analytics, no iframes, no external images. Use CSS for anything decorative. If a photograph is genuinely needed, leave a clearly marked empty block with a note saying what belongs there.
- Responsive to 360px without horizontal scrolling. Real headings in order, one <h1>, buttons that are buttons or links, alt text on anything that needs it.
- Every contact detail and every proof claim comes from what you were given, verbatim. This is a page a regulator or a disappointed customer reads back to you.`;

  const prompt = `Write ${kind}.

WHAT THIS PAGE IS FOR — the operator's brief
${page.brief}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY — what is being sold and what may not be promised
${renderUpstream(offer)}

ICP AND BRAND STRATEGY — who is reading, and the voice to hold
${renderUpstream(records.filter((r) => r.domain !== "offer_strategy"))}

${packageBlock}
${adBlock}
Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Writing ${page.page_type} page "${page.title}".`);

  let result;
  try {
    result = await runAgentLoop({
      apiKey: anthropicKeyForAgent(runtime, agent.agent_key),
      model: runtime.model,
      timeoutMs: runtime.providerTimeoutMs,
      deadlineAt,
      system,
      prompt,
      submitTool,
      enableWebSearch: false,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        retryable: error.retryable,
        failureMessage: error.message,
        usage: error.usage
          ? {
              inputTokens: error.usage.inputTokens,
              outputTokens: error.usage.outputTokens,
              costUsd: error.usage.costUsd,
            }
          : undefined,
      };
    }
    throw error;
  }

  const usage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
  };

  const s = (key: string) => String(result.submitted[key] ?? "").trim();
  const headline = s("headline");
  const html = s("html");

  const problem = isRecruitment
    ? recruitmentPageProblem(headline, html)
    : pageProblem(headline, html);
  if (problem) {
    return { ok: false, retryable: true, failureMessage: problem, usage };
  }

  // body keeps a readable summary so a page is legible without rendering it.
  const summary = [`# ${headline}`, s("subheadline"), "", `**Call to action:** ${s("primary_cta")}`]
    .filter(Boolean)
    .join("\n\n");

  const { error } = await sb
    .from("client_pages")
    .update({
      title: s("title") || page.title,
      html,
      meta_title: s("meta_title") || null,
      meta_description: s("meta_description") || null,
      body: summary,
      built_at: new Date().toISOString(),
      job_id: job.id,
    })
    .eq("id", page.id);
  if (error) throw new Error(`Failed to write page: ${error.message}`);

  await appendEvent(sb, job.id, `Wrote "${s("title") || page.title}".`, "info", {
    cost_usd: usage.costUsd,
  });
  return { ok: true, retryable: false, usage };
}
