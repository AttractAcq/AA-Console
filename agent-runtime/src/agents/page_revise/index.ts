// Page Reviser: applies the findings a person chose, and nothing else.
//
// Two rules make this safe, and both are enforced here rather than asked for in
// the prompt:
//
//   1. It is only ever handed FIXABLE findings. A NEEDS_PERSON finding is
//      filtered out before the model sees it, so there is no "fix the missing
//      testimonial" instruction for it to comply with.
//   2. Its output goes through the same htmlSafetyProblem as a fresh build.
//      A revision path weaker than the generation path is the same bug as no
//      checks at all, and after Phase 10 these pages are served publicly with
//      no sandbox.
//
// It reads its instructions from client_page_findings rows the console marked
// `selected`, rather than from job params — which makes the selection auditable
// after the fact instead of vanishing with the request.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicKeyForAgent, type RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { ProviderError, runAgentLoop } from "../../tools/anthropic.js";
import { loadUpstreamRecords, renderContext, renderUpstream } from "../shared.js";
import type { BusinessContext } from "../shared.js";
import { loadPagePackage, renderPackage } from "../landing_page/aggregate.js";
import { htmlSafetyProblem } from "../landing_page/safety.js";

type FindingRow = {
  id: string;
  category: string;
  title: string;
  explanation: string;
  suggested_direction: string | null;
  classification: string;
};

export async function runPageReviseJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Page revisions require a client." };
  }
  if (job.input_table !== "client_pages" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent revises a page — it has no page to work on.",
    };
  }

  const { data: page, error: pageError } = await sb
    .from("client_pages")
    .select("id, title, brief, html, current_revision")
    .eq("id", job.input_id)
    .maybeSingle();
  if (pageError) throw new Error(`Failed to load page: ${pageError.message}`);
  if (!page || !page.html) {
    return { ok: false, retryable: false, failureMessage: "That page has no built HTML to revise." };
  }

  const { data: selectedRaw, error: findingError } = await sb
    .from("client_page_findings")
    .select("id, category, title, explanation, suggested_direction, classification")
    .eq("page_id", page.id)
    .eq("status", "selected");
  if (findingError) throw new Error(`Failed to load findings: ${findingError.message}`);

  const selected = (selectedRaw ?? []) as FindingRow[];
  if (selected.length === 0) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "No findings are selected. Choose what to fix and try again.",
    };
  }

  // The guard, not the prompt. Even if something upstream managed to mark a
  // NEEDS_PERSON finding as selected, the model is never told about it — there
  // is no instruction for it to satisfy by inventing the missing fact.
  const fixable = selected.filter((f) => f.classification === "FIXABLE");
  const refused = selected.filter((f) => f.classification !== "FIXABLE");

  if (fixable.length === 0) {
    // Put the refused ones back so they stay visible as outstanding gaps.
    await sb
      .from("client_page_findings")
      .update({ status: "open", updated_at: new Date().toISOString() })
      .in("id", refused.map((f) => f.id));
    return {
      ok: false,
      retryable: false,
      failureMessage:
        "Every selected finding needs a real fact — a testimonial, a price, a guarantee or a credential. Those cannot be written by an agent; someone has to supply them.",
    };
  }

  const { data: clientRow } = await sb
    .from("clients")
    .select("name")
    .eq("id", job.client_id)
    .maybeSingle();
  const clientName = (clientRow?.name as string | undefined) ?? "this business";

  const [{ data: context }, records, pkg] = await Promise.all([
    sb
      .from("client_business_context")
      .select(
        "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
      )
      .eq("client_id", job.client_id)
      .maybeSingle(),
    loadUpstreamRecords(sb, job.client_id, ["offer_strategy", "icp", "brand_strategy"]),
    loadPagePackage(sb, job.client_id, clientName),
  ]);

  const submitTool = {
    name: "submit_revision",
    description: "Submit the revised page. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description:
            "The complete revised page: <!doctype html> through </html>, all CSS in one <style> block in the head. No <script>, no iframe, no inline event handlers, no external resources.",
        },
        summary: {
          type: "string",
          description: "What you changed and why, in two or three sentences a person can check against the page.",
        },
        not_applied: {
          type: "string",
          description:
            "Any selected finding you did not apply, and why. Leaving something alone is a valid outcome; saying nothing about it is not.",
        },
      },
      required: ["html", "summary"],
      additionalProperties: false,
    },
  };

  const system = `You revise conversion pages for Attract Acquisition, a marketing agency.

You are given a page that already works and a short list of specific problems a person has chosen to fix. Your job is to fix those and leave everything else alone.

WHAT TO CHANGE
- Fix what is on the list. Do not rewrite the page.
- Preserve every claim, number, name, contact detail and proof point exactly as it appears. If a sentence is not part of a listed problem, it should survive unchanged.
- Keep the structure unless a listed problem is about the structure.

ABSOLUTE RULES
- Never add a fact that is not already on the page or in what you were given. No testimonial, no statistic, no price, no guarantee, no credential, no award, no customer count, no years in business, no location you were not told about.
- If fixing a listed problem would require a fact you do not have, do not invent it — leave that part as it is and say so in not_applied. Leaving something unfixed is a correct outcome.
- Only reference proof you were given as cleared.
- Match the brand voice you are given.

THE OUTPUT
Return the complete page, not a fragment or a diff. All styling stays in one <style> block in the head. No <script> of any kind, no iframe, no inline event handlers, no external stylesheets, fonts or images — this page is served publicly and must render offline and identically for everyone.`;

  const findingList = fixable
    .map(
      (f, i) =>
        `${i + 1}. [${f.category}] ${f.title}\n   Why it matters: ${f.explanation}${
          f.suggested_direction ? `\n   Direction: ${f.suggested_direction}` : ""
        }`,
    )
    .join("\n\n");

  const prompt = `Revise this ${clientName} page.

THE PROBLEMS TO FIX — these and nothing else
${findingList}

WHAT THE PAGE IS FOR — the operator's brief
${page.brief ?? "(no brief recorded)"}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY AND ICP
${renderUpstream(records)}

${renderPackage(pkg, null)}

THE CURRENT PAGE
${page.html}

Call ${submitTool.name} once when you are done.`;

  await appendEvent(
    sb,
    job.id,
    `Revising "${page.title}" — ${fixable.length} finding${fixable.length === 1 ? "" : "s"} to fix.`,
  );

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

  const html = String(result.submitted.html ?? "").trim();
  const summary = String(result.submitted.summary ?? "").trim();
  const notApplied = String(result.submitted.not_applied ?? "").trim();

  // The same check a fresh build gets. Not a copy of it — the same function.
  const problem = htmlSafetyProblem(html);
  if (problem) {
    return { ok: false, retryable: true, failureMessage: problem, usage };
  }

  const { data: revisionNumber, error: revisionError } = await sb.rpc("record_page_revision", {
    p_page_id: page.id,
    p_html: html,
    p_source: "agent_revision",
    p_summary: summary || "Applied selected findings.",
    p_reason: fixable.map((f) => f.title).join("; "),
    p_job_id: job.id,
  });
  if (revisionError) throw new Error(`Failed to record revision: ${revisionError.message}`);

  // The findings that were acted on are closed; anything refused goes back to
  // open so it stays on the page's list of outstanding gaps.
  await sb
    .from("client_page_findings")
    .update({ status: "applied", updated_at: new Date().toISOString() })
    .in("id", fixable.map((f) => f.id));
  if (refused.length > 0) {
    await sb
      .from("client_page_findings")
      .update({ status: "open", updated_at: new Date().toISOString() })
      .in("id", refused.map((f) => f.id));
  }

  await appendEvent(
    sb,
    job.id,
    [
      `Revision ${revisionNumber} of "${page.title}".`,
      summary,
      notApplied ? `Not applied: ${notApplied}` : "",
      refused.length > 0
        ? `${refused.length} selected finding${refused.length === 1 ? "" : "s"} needed a real fact and was left for a person.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    "info",
    { cost_usd: usage.costUsd },
  );
  return { ok: true, retryable: false, usage };
}
