// What a campaign plan has to contain before anything is built from it.
//
// In its own module because these are the rules that decide whether real rows
// get created in tools 2 and 3 and real money gets spent against them. A rule
// living inline in the job function can be deleted without a test failing,
// which is how four earlier tools shipped an unguarded check.

export interface CampaignPlan {
  objective: string;
  audience: string;
  offer_summary: string;
  core_message: string;
  channels: string[];
  budget: number | null;
  starts_on: string | null;
  ends_on: string | null;
  kpi_metric: string;
  kpi_target: number | null;
  content_count: number;
  needs_landing_page: boolean;
  needs_sales_agent: boolean;
}

/** The most content one campaign may ask for in a single plan. */
export const MAX_CONTENT = 30;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A whole, non-negative count, or 0 for anything that is not one. */
export function asCount(v: unknown, max = MAX_CONTENT): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

/** A positive amount, or null. Zero budget and "unknown" are different answers. */
export function asAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * An ISO date, or null.
 *
 * A malformed date must not reach the column: Postgres would reject the whole
 * write and the plan would be lost after it was paid for.
 */
export function asDate(v: unknown): string | null {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(new Date(s).getTime()) ? null : s;
}

export function normaliseChannels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const c of raw) {
    const s = str(c).toLowerCase();
    if (s) seen.add(s);
  }
  return [...seen];
}

/**
 * Why this plan cannot be accepted, or null if it can.
 *
 * The last rule is the one that matters most: a plan that asks for nothing to
 * be built is not a campaign, it is a note. Accepting one would give the
 * readiness check nothing to measure, and a campaign with no requirements
 * reports itself ready the moment it is planned — which is exactly the false
 * "ready" this tool exists to prevent.
 */
export function planProblem(plan: CampaignPlan): string | null {
  if (!plan.objective) return "The plan came back with no objective.";
  if (!plan.audience) return "The plan came back with nobody to aim at.";
  if (!plan.core_message) return "The plan came back with no message to carry.";
  if (plan.channels.length === 0) {
    return "The plan came back with no channel, so there is nowhere to run it.";
  }
  if (!plan.kpi_metric) {
    return "The plan came back with no KPI. A campaign nobody can score is a campaign nobody can stop.";
  }
  if (plan.ends_on && plan.starts_on && plan.ends_on < plan.starts_on) {
    return "The plan came back ending before it starts.";
  }
  if (plan.content_count === 0 && !plan.needs_landing_page && !plan.needs_sales_agent) {
    return "The plan asks for nothing to be built, so there is no campaign to execute.";
  }
  return null;
}

/** The readable summary, so a plan is legible without opening every field. */
export function planSummary(plan: CampaignPlan): string {
  const needs = [
    plan.content_count > 0 ? `${plan.content_count} pieces of content` : null,
    plan.needs_landing_page ? "a landing page" : null,
    plan.needs_sales_agent ? "a sales agent" : null,
  ].filter(Boolean);
  return [
    `**Objective:** ${plan.objective}`,
    `**Audience:** ${plan.audience}`,
    `**Message:** ${plan.core_message}`,
    `**Channels:** ${plan.channels.join(", ")}`,
    `**Scored on:** ${plan.kpi_metric}${plan.kpi_target !== null ? ` (target ${plan.kpi_target})` : ""}`,
    `**Needs built:** ${needs.join(", ")}`,
  ].join("\n\n");
}
