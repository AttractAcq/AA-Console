// The generic half of every record-producing agent.
//
// The shape of an agent's output comes from record_templates, not from
// code: adding a template row changes what the agent is asked to produce
// without a deploy. Each domain module supplies only its prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubmitToolSpec } from "../tools/anthropic.js";
import type { AgentJobRow } from "../queue.js";
import { logger } from "../logging/logger.js";

export interface Template {
  item_key: string;
  item_type: string;
  title: string;
  description: string | null;
  display_order: number;
}

export interface BusinessContext {
  business_overview: string | null;
  ideal_customer: string | null;
  main_offer: string | null;
  competitors: string | null;
  brand_voice: string | null;
  proof_testimonials: string | null;
  current_marketing: string | null;
  sales_process: string | null;
  current_revenue: string | null;
  target_revenue: string | null;
}

export interface DomainContext {
  templates: Template[];
  context: BusinessContext | null;
  input: Record<string, unknown>;
}

export async function loadDomainContext(
  sb: SupabaseClient,
  job: AgentJobRow,
  domain: string,
): Promise<DomainContext> {
  const [templatesRes, contextRes] = await Promise.all([
    sb
      .from("record_templates")
      .select("item_key, item_type, title, description, display_order")
      .eq("domain", domain)
      .order("display_order"),
    job.client_id
      ? sb
          .from("client_business_context")
          .select(
            "business_overview, ideal_customer, main_offer, competitors, brand_voice, proof_testimonials, current_marketing, sales_process, current_revenue, target_revenue",
          )
          .eq("client_id", job.client_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (templatesRes.error) throw new Error(`Failed to load templates: ${templatesRes.error.message}`);
  const templates = (templatesRes.data ?? []) as Template[];
  if (templates.length === 0) throw new Error(`No record_templates defined for domain "${domain}".`);

  let input: Record<string, unknown> = {};
  if (job.input_table === "client_agent_inputs" && job.input_id) {
    const { data } = await sb
      .from("client_agent_inputs")
      .select("payload, notes")
      .eq("id", job.input_id)
      .maybeSingle();
    input = (data?.payload as Record<string, unknown>) ?? {};
    if (data?.notes) input.notes = data.notes;
  }

  return { templates, context: (contextRes.data as BusinessContext) ?? null, input };
}

export interface UpstreamRecord {
  domain: string;
  item_key: string;
  title: string;
  body: string | null;
}

/**
 * Loads the records a synthesis agent depends on. Brand Strategy reads
 * ICP, Competitor and Association; Money Model reads Offer Strategy. The
 * database gate (can_run_agent) already refuses to queue these before
 * their upstream has completed, so anything missing here is a real fault.
 */
export async function loadUpstreamRecords(
  sb: SupabaseClient,
  clientId: string,
  domains: string[],
): Promise<UpstreamRecord[]> {
  if (domains.length === 0) return [];
  const { data, error } = await sb
    .from("client_agent_records")
    .select("domain, item_key, title, body")
    .eq("client_id", clientId)
    .in("domain", domains)
    .order("domain")
    .order("display_order");
  if (error) throw new Error(`Failed to load upstream records: ${error.message}`);
  return ((data ?? []) as UpstreamRecord[]).filter((r) => (r.body ?? "").trim().length > 0);
}

/** Renders upstream records as prompt text, grouped by domain. */
export function renderUpstream(records: UpstreamRecord[]): string {
  if (records.length === 0) return "(no upstream records found)";
  const byDomain = new Map<string, UpstreamRecord[]>();
  for (const record of records) {
    const list = byDomain.get(record.domain) ?? [];
    list.push(record);
    byDomain.set(record.domain, list);
  }
  return [...byDomain.entries()]
    .map(([domain, items]) =>
      `### ${domain}\n` + items.map((i) => `**${i.title}**\n${i.body}`).join("\n\n"),
    )
    .join("\n\n");
}

/** Renders the business context as prompt text, omitting anything blank. */
export function renderContext(context: BusinessContext | null): string {
  if (!context) return "(no business context has been captured for this client yet)";
  const labels: Array<[keyof BusinessContext, string]> = [
    ["business_overview", "Business overview"],
    ["ideal_customer", "Ideal customer"],
    ["main_offer", "Main offer"],
    ["competitors", "Competitors named by the client"],
    ["brand_voice", "Brand voice and what never to say"],
    ["proof_testimonials", "Proof and testimonials"],
    ["current_marketing", "Current marketing"],
    ["sales_process", "Sales process"],
    ["current_revenue", "Current revenue"],
    ["target_revenue", "Target revenue"],
  ];
  const lines = labels
    .map(([key, label]) => [label, (context[key] ?? "").toString().trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`);
  return lines.length > 0 ? lines.join("\n\n") : "(business context is empty)";
}

/**
 * A submit tool whose schema is exactly the domain's templates: one
 * required string per item_key, additionalProperties false. With
 * strict: true this guarantees the payload has every section and nothing
 * else, so persistence never has to defend against a malformed shape.
 */
export function buildSubmitTool(domain: string, templates: Template[]): SubmitToolSpec {
  const properties: Record<string, unknown> = {};
  for (const template of templates) {
    properties[template.item_key] = {
      type: "string",
      description: [template.title, template.description].filter(Boolean).join(" — "),
    };
  }
  return {
    name: "submit_analysis",
    description: `Submit the finished ${domain} analysis. Call this exactly once, when you have finished researching. Every section is required and must contain real findings.`,
    inputSchema: {
      type: "object",
      properties,
      required: templates.map((t) => t.item_key),
      additionalProperties: false,
    },
  };
}

// Anything matching this is a refusal to actually answer. v5 shipped a
// PROVIDER_PLACEHOLDER_OUTPUT failure code because models under output
// pressure degrade to these rather than shortening.
const PLACEHOLDER = /^(n\/?a|none|tbd|todo|placeholder|sample|unused|unknown|-{1,}|\.{3})$/i;

export function findPlaceholders(sections: Record<string, string>): string[] {
  return Object.entries(sections)
    .filter(([, value]) => {
      const text = (value ?? "").trim();
      return text.length < 40 || PLACEHOLDER.test(text);
    })
    .map(([key]) => key);
}

export interface PersistResult {
  written: number;
  preserved: string[];
}

/**
 * Writes one record per template. A record a human has edited is left
 * alone — a re-run must never silently overwrite someone's work, which is
 * what edited_at exists to signal.
 */
export async function persistRecords(
  sb: SupabaseClient,
  args: {
    clientId: string;
    domain: string;
    jobId: string;
    templates: Template[];
    sections: Record<string, string>;
    period?: string | null;
  },
): Promise<PersistResult> {
  const { clientId, domain, jobId, templates, sections, period = null } = args;

  const { data: existing, error: existingError } = await sb
    .from("client_agent_records")
    .select("item_key, edited_at")
    .eq("client_id", clientId)
    .eq("domain", domain);
  if (existingError) throw new Error(`Failed to read existing records: ${existingError.message}`);

  const humanEdited = new Set(
    (existing ?? []).filter((r) => r.edited_at !== null).map((r) => r.item_key as string),
  );

  const rows = templates
    .filter((t) => !humanEdited.has(t.item_key))
    .map((t) => ({
      client_id: clientId,
      domain,
      job_id: jobId,
      item_key: t.item_key,
      item_type: t.item_type,
      title: t.title,
      body: (sections[t.item_key] ?? "").trim(),
      period,
      display_order: t.display_order,
      status: "draft" as const,
    }));

  if (rows.length > 0) {
    const { error } = await sb
      .from("client_agent_records")
      .upsert(rows, { onConflict: "client_id,domain,item_key,period" });
    if (error) throw new Error(`Failed to write records: ${error.message}`);
  }

  const preserved = [...humanEdited];
  if (preserved.length > 0) {
    logger.info("records_preserved_human_edits", { domain, clientId, preserved });
  }
  return { written: rows.length, preserved };
}
