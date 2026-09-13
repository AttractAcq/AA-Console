// Page Auditor: says what is wrong with a page and nothing else.
//
// It cannot write HTML. That is not an oversight to be fixed later — the whole
// reason the polish loop is two agents is that a single "improve this page"
// button gives a person no say in what changes, and the cheapest way for a
// model to close a finding about a missing testimonial is to write one.
//
// So this reports, a person chooses, and the reviser acts only on what was
// chosen. The classification that decides what is choosable is derived from a
// closed category list in code, not supplied by the model.

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
import {
  ALL_CATEGORIES,
  auditSummary,
  MAX_FINDINGS,
  normaliseFindings,
  NEEDS_PERSON_CATEGORIES,
} from "./findings.js";

export async function runPageAuditJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  deadlineAt: number,
): Promise<JobResult> {
  if (!job.client_id) {
    return { ok: false, retryable: false, failureMessage: "Page audits require a client." };
  }
  if (job.input_table !== "client_pages" || !job.input_id) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This agent audits a page — it has no page to look at.",
    };
  }

  const { data: page, error: pageError } = await sb
    .from("client_pages")
    .select("id, title, brief, html, current_revision")
    .eq("id", job.input_id)
    .maybeSingle();
  if (pageError) throw new Error(`Failed to load page: ${pageError.message}`);
  if (!page) {
    return { ok: false, retryable: false, failureMessage: "That page no longer exists." };
  }
  if (!page.html) {
    return {
      ok: false,
      retryable: false,
      failureMessage: "This page has not been built yet. There is nothing to audit.",
    };
  }

  const revision = (page.current_revision as number | null) ?? 1;

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
    name: "submit_findings",
    description: "Submit what is wrong with this page. Call this exactly once, even if nothing is wrong.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          description: `Up to ${MAX_FINDINGS} findings, most important first. An empty list is a valid answer.`,
          items: {
            type: "object",
            properties: {
              // A closed list. The classification is derived from this, not
              // chosen — which is why the model is never asked for one.
              category: {
                type: "string",
                enum: ALL_CATEGORIES,
                description:
                  "What kind of problem this is. Choose the category that most precisely describes it.",
              },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              title: { type: "string", description: "The problem in one line, stated as what is wrong." },
              explanation: {
                type: "string",
                description: "Why it costs conversions, referring to what is actually on the page.",
              },
              suggested_direction: {
                type: "string",
                description:
                  "What good would look like. For anything needing real evidence, say what evidence is needed — never supply it.",
              },
            },
            required: ["category", "severity", "title", "explanation", "suggested_direction"],
            additionalProperties: false,
          },
        },
        overall: { type: "string", description: "One or two sentences on the page as a whole." },
      },
      required: ["findings", "overall"],
      additionalProperties: false,
    },
  };

  const system = `You audit conversion pages for Attract Acquisition, a marketing agency.

You report problems. You do not write or rewrite the page, and you are not asked to.

HOW TO READ THE PAGE
- Read it as the buyer described in the ICP would, in the order it is laid out. A visitor who stops reading has been failed by the previous sentence.
- Judge it against the offer strategy and the brand voice you are given, not against generic best practice.
- Say what is actually on the page. "The headline is weak" is not a finding; "the headline names the practice instead of what the buyer gets" is.

THE CATEGORY DECIDES WHAT HAPPENS NEXT
Every finding gets a category from the list, and the category decides whether a writer can act on it alone or whether a person has to supply something real first.

These categories mean a fact is missing that nobody has yet — a customer who said something, a number that was measured, a price that was set, a qualification somebody holds:
${NEEDS_PERSON_CATEGORIES.join(", ")}

Use them honestly. If the page needs a testimonial, that is a testimonial finding, however easy it would be to write one.

ABSOLUTE RULES
- Never supply the missing evidence. Not in the title, not in the explanation, not in the suggested direction. Say what is needed, never what it should say.
- Never treat a missing fact as a writing problem. A page with no proof does not have a "clarity" problem.
- Only reference proof you were actually given as cleared. If the page cites something you were not given, that is itself a finding.
- An empty findings list is a valid answer. Do not invent problems to look thorough.`;

  const prompt = `Audit this ${clientName} page.

WHAT THE PAGE IS FOR — the operator's brief
${page.brief ?? "(no brief recorded)"}

BUSINESS CONTEXT
${renderContext(context as BusinessContext | null)}

OFFER STRATEGY AND ICP
${renderUpstream(records)}

${renderPackage(pkg, null)}

THE PAGE AS IT STANDS (revision ${revision})
${page.html}

Call ${submitTool.name} once when you are done.`;

  await appendEvent(sb, job.id, `Auditing "${page.title}" (revision ${revision}).`);

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

  const findings = normaliseFindings(result.submitted.findings);

  // Findings from an earlier revision are no longer reliable about this one, so
  // they are marked stale rather than deleted — what was already known about
  // the page is worth keeping, it is just no longer current.
  const { error: staleError } = await sb
    .from("client_page_findings")
    .update({ status: "stale", updated_at: new Date().toISOString() })
    .eq("page_id", page.id)
    .in("status", ["open", "selected"])
    .neq("revision_number", revision);
  if (staleError) throw new Error(`Failed to age previous findings: ${staleError.message}`);

  // Re-auditing the same revision replaces that revision's open findings rather
  // than stacking a second copy of every one.
  const { error: clearError } = await sb
    .from("client_page_findings")
    .delete()
    .eq("page_id", page.id)
    .eq("revision_number", revision)
    .in("status", ["open", "selected"]);
  if (clearError) throw new Error(`Failed to clear previous findings: ${clearError.message}`);

  if (findings.length > 0) {
    const { error: insertError } = await sb.from("client_page_findings").insert(
      findings.map((f) => ({
        client_id: job.client_id,
        page_id: page.id,
        revision_number: revision,
        category: f.category,
        severity: f.severity,
        title: f.title,
        explanation: f.explanation,
        suggested_direction: f.suggested_direction || null,
        classification: f.classification,
        status: "open",
        job_id: job.id,
      })),
    );
    if (insertError) throw new Error(`Failed to write findings: ${insertError.message}`);
  }

  const overall = String(result.submitted.overall ?? "").trim();
  await appendEvent(
    sb,
    job.id,
    `${auditSummary(findings)}${overall ? `\n\n${overall}` : ""}`,
    "info",
    { cost_usd: usage.costUsd },
  );
  return { ok: true, retryable: false, usage };
}
