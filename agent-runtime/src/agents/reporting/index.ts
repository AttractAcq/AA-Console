// Reporting commentary.
//
// The only place a model belongs in the reporting pipeline. It fetches
// nothing and writes no number — it reads what metrics_ingest already put
// in metrics_daily and says what it means.
//
// The hard constraint is arithmetic honesty. Everything in the prompt is
// pre-aggregated here, in code, so the model is never asked to add up a
// column and never has a reason to guess one. If a figure is not in the
// summary below, it does not exist.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../../queue.js";
import { createRecordAgent, type PromptArgs } from "../factory.js";
import { renderContext, renderUpstream } from "../shared.js";
import type { BusinessContext } from "../shared.js";

const DEFAULT_DAYS = 30;

/**
 * The shape of metrics_period_summary(). The aggregation rules live in that
 * function rather than here on purpose: the reporting panels read the same
 * one, so a chart and this commentary cannot disagree about a number.
 */
export interface PeriodSummary {
  window: { since: string; until: string };
  paid: {
    spend: number; impressions: number; clicks: number; conversions: number;
    days_covered: number; currency: string | null;
  };
  paid_campaigns: Array<{
    external_id: string; campaign_ref: string | null; target_role: string | null;
    mapped: boolean; spend: number; impressions: number; clicks: number;
    conversions: number; days_active: number;
  }>;
  organic_account: {
    impressions: number; best_day_reach: number; engagements: number; days_covered: number;
  };
  organic_posts: Array<{
    external_id: string; ref_number: string | null; media_type: string | null;
    mapped: boolean; as_at: string; impressions: number | null;
    reach: number | null; engagements: number | null;
  }>;
  unmapped_rows: number;
  total_rows: number;
}

const money = (value: number, currency: string | null): string =>
  `${currency ? `${currency} ` : ""}${Number(value).toFixed(2)}`;

const rate = (numerator: number, denominator: number): string =>
  denominator > 0 ? (numerator / denominator).toFixed(2) : "n/a";

/**
 * Turns the aggregate into prose the model can read. Every figure here came
 * out of the database already computed — nothing is calculated in this
 * function except two ratios, which are labelled as derived so the model
 * does not present them as measured.
 */
export function formatSummary(s: PeriodSummary): string {
  const lines: string[] = [`Period: ${s.window.since} to ${s.window.until}.`];

  if (s.paid.days_covered > 0) {
    lines.push(
      "",
      "PAID (daily figures, summed across the period)",
      `- Spend: ${money(s.paid.spend, s.paid.currency)}`,
      `- Impressions: ${s.paid.impressions}`,
      `- Clicks: ${s.paid.clicks}`,
      `- Conversions: ${s.paid.conversions}`,
      `- Cost per click (derived): ${rate(s.paid.spend, s.paid.clicks)}`,
      `- Cost per conversion (derived): ${
        s.paid.conversions > 0 ? rate(s.paid.spend, s.paid.conversions) : "no conversions recorded"
      }`,
      `- Days with data: ${s.paid.days_covered}`,
      "",
      "Per campaign:",
    );
    for (const c of s.paid_campaigns) {
      const name = c.campaign_ref
        ? `${c.campaign_ref}${c.target_role ? ` (${c.target_role})` : ""}`
        : `(not in the console, external id ${c.external_id})`;
      lines.push(
        `- ${name}: spend ${money(c.spend, s.paid.currency)}, impressions ${c.impressions}, ` +
          `clicks ${c.clicks}, conversions ${c.conversions}, ` +
          `cost per conversion ${c.conversions > 0 ? rate(c.spend, c.conversions) : "n/a"}, ` +
          `active on ${c.days_active} day(s)`,
      );
    }
  } else {
    lines.push("", "PAID: no data ingested for this period.");
  }

  if (s.organic_account.days_covered > 0) {
    lines.push(
      "",
      "ORGANIC ACCOUNT (daily figures)",
      `- Impressions across the period: ${s.organic_account.impressions}`,
      // Reach counts people, so it is never summed across days.
      `- Best single day for reach: ${s.organic_account.best_day_reach}`,
      `- Interactions: ${s.organic_account.engagements}`,
      `- Days with data: ${s.organic_account.days_covered}`,
    );
  } else {
    lines.push("", "ORGANIC ACCOUNT: no data ingested for this period.");
  }

  if (s.organic_posts.length > 0) {
    lines.push(
      "",
      `ORGANIC POSTS (${s.organic_posts.length}). These are lifetime-to-date totals as at the date shown, NOT what the post earned during this period. Never add them together or present them as period figures.`,
    );
    for (const p of s.organic_posts.slice(0, 10)) {
      const name = p.ref_number
        ? `${p.ref_number}${p.media_type ? ` (${p.media_type})` : ""}`
        : `(not in the console, media id ${p.external_id})`;
      lines.push(
        `- ${name}: impressions ${p.impressions ?? "n/a"}, reach ${p.reach ?? "n/a"}, ` +
          `interactions ${p.engagements ?? "n/a"} (as at ${p.as_at})`,
      );
    }
  } else {
    lines.push("", "ORGANIC POSTS: no data ingested for this period.");
  }

  if (s.unmapped_rows > 0) {
    lines.push(
      "",
      `${s.unmapped_rows} row(s) could not be matched to a campaign or post in the console. ` +
        "Those are real numbers for things nobody created here, and are worth flagging.",
    );
  }

  return lines.join("\n");
}

async function loadMetrics(
  sb: SupabaseClient,
  job: AgentJobRow,
): Promise<{ text: string; block?: string }> {
  const params = (job.params ?? {}) as Record<string, unknown>;

  // The period can come from the Run Agent form as well as from job params,
  // because "last 7 days" and "last 90 days" tell genuinely different
  // stories about the same account.
  let days = DEFAULT_DAYS;
  if (job.input_table === "client_agent_inputs" && job.input_id) {
    const { data: row } = await sb
      .from("client_agent_inputs")
      .select("payload")
      .eq("id", job.input_id)
      .maybeSingle();
    const payload = (row?.payload ?? {}) as Record<string, unknown>;
    const requested = Number(payload.period_days);
    if (Number.isFinite(requested) && requested > 0) days = Math.min(requested, 365);
  }

  const until = new Date();
  const since = new Date(until.getTime() - days * 86_400_000);

  const { data, error } = await sb.rpc("metrics_period_summary", {
    p_client_id: job.client_id,
    p_since: typeof params.since === "string" ? params.since : since.toISOString().slice(0, 10),
    p_until: typeof params.until === "string" ? params.until : until.toISOString().slice(0, 10),
  });
  if (error) throw new Error(`Could not read metrics: ${error.message}`);

  const summary = data as PeriodSummary | null;
  if (!summary || summary.total_rows === 0) {
    return {
      text: "",
      block:
        "No metrics have been ingested for this client in this period. Connect an integration and let the daily sync run, or run Metrics Ingest by hand first.",
    };
  }

  return { text: formatSummary(summary) };
}

export const runReportingJob = createRecordAgent({
  domain: "reporting",

  system: `You write the reporting commentary for Attract Acquisition, a marketing agency. Your reader is the operator who is about to talk to the client, and what you write may be read to them directly.

ARITHMETIC
Every figure has been calculated for you and is in the summary. Use those numbers exactly as given. Do not compute a new total, average or rate that is not there — if you need one that is missing, say it is not available rather than working it out. A number you derived is a number nobody checked.

WHAT MAKES THIS USEFUL
- Lead with the thing that changed, not with a recap of what was done.
- A movement is only worth reporting if it is big enough to act on. Say plainly when something is noise, and say plainly when a window is too short or a spend too small for a rate to mean anything.
- Name the specific campaign or post. "Video content performed well" is not a finding; "AA-ORG-016 carried 60% of the month's impressions" is.
- Recommendations must follow from a figure in the summary. General marketing advice that would be true for any client is worse than saying nothing.

HONESTY
- Never invent a figure, a comparison to a previous period you were not given, or a benchmark.
- If the data does not support a conclusion, the correct output is that it does not. An operator who reads a confident story into thin data will repeat it to the client.
- Cumulative post figures are lifetime-to-date, not this period's. Never present them as if they were earned during the window.`,

  buildPrompt: (args: PromptArgs) =>
    `Write the reporting commentary for this client.

THE NUMBERS — this is the complete set of figures available to you
${args.extra}

BUSINESS CONTEXT — who this client is and what they sell
${renderContext(args.context as BusinessContext | null)}

STRATEGY ON FILE — what the campaigns were supposed to achieve
${renderUpstream(args.upstream)}

SECTIONS TO RETURN
${args.sectionBrief}

Call ${args.submitToolName} once when you are done.`,

  upstreamDomains: [],
  enableWebSearch: false,
  loadExtra: loadMetrics,
  describeStart: () => "Reading ingested metrics and writing the commentary.",
});
