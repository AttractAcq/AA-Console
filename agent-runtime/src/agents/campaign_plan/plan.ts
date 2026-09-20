import { derivedNeeds, type CampaignTemplate } from "../../campaigns/templates.js";

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

export interface CampaignIdea {
  title: string;
  body: string;
  media_type: "image" | "text" | "video";
  channel: string;
  strategic_reason: string;
  /** The content pillar this piece sits in, when the campaign has any. */
  pillar_id: string | null;
  /** 'single', 'carousel' or 'story'. Decides how it is briefed and produced. */
  content_format: "single" | "carousel" | "story";
}

/** Reject incomplete batches rather than silently saving fewer ideas than promised. */
/**
 * Assigns an idea to one of the campaign's pillars.
 *
 * A campaign that names pillars is a campaign whose content sits inside
 * them, so every idea must name one — and it must be one of ITS pillars,
 * not any pillar the client happens to have. An idea filed under a pillar
 * the campaign is not running is worse than an unfiled one: it lands in
 * somebody else's calendar share and nothing flags it.
 *
 * A campaign with no pillars is the existing behaviour, unchanged.
 */
function assignedPillar(raw: unknown, allowed: readonly string[], title: string): string | null {
  if (allowed.length === 0) return null;
  const chosen = str(raw);
  if (!chosen) {
    throw new Error(`"${title}" was not assigned to a content pillar, and this campaign runs within pillars.`);
  }
  if (!allowed.includes(chosen)) {
    throw new Error(`"${title}" was assigned to a pillar this campaign is not running.`);
  }
  return chosen;
}


/** What a format can be made of. A carousel is images; a story is either. */
export const FORMAT_MEDIA: Record<string, readonly string[]> = {
  single: ["image", "text", "video"],
  carousel: ["image"],
  story: ["image", "video"],
};

/**
 * The format this piece is produced in, checked against what it is made of.
 *
 * A carousel of video is a story, and a text story is nothing. Correcting
 * the pair silently is how a campaign ends up producing something nobody
 * asked for, so an impossible pair is refused and the planner writes the
 * batch again.
 *
 * Absent means single, which is every campaign planned before formats
 * existed and most pieces after.
 */
function chosenFormat(raw: unknown, mediaType: string, title: string): CampaignIdea["content_format"] {
  const asked = str(raw) || "single";
  const allowed = FORMAT_MEDIA[asked];
  if (!allowed) {
    throw new Error(`"${title}" asks for a format that does not exist: ${asked}.`);
  }
  if (!allowed.includes(mediaType)) {
    const advice =
      asked === "carousel"
        ? "a carousel is images, and a set of clips is a story"
        : "a story is a still or a clip";
    throw new Error(`"${title}" asks for a ${asked} of ${mediaType}; ${advice}.`);
  }
  return asked as CampaignIdea["content_format"];
}

export function campaignIdeas(
  raw: unknown,
  expected: number,
  pillarIds: readonly string[] = [],
): CampaignIdea[] {
  if (!Number.isInteger(expected) || expected < 0 || expected > MAX_CONTENT ||
      !Array.isArray(raw) || raw.length !== expected) {
    throw new Error(`The campaign needs exactly ${expected} distinct ideas.`);
  }
  const titles = new Set<string>();
  return raw.map((value) => {
    const item = value as Record<string, unknown> | null;
    const title = str(item?.title);
    const body = str(item?.body);
    const channel = str(item?.channel);
    const strategic_reason = str(item?.strategic_reason);
    const media_type = item?.media_type;
    if (!title || title.length > 300 || !body || !channel || !strategic_reason ||
        !["image", "text", "video"].includes(String(media_type)) || titles.has(title.toLowerCase())) {
      throw new Error("Each campaign idea needs a distinct title, angle, channel, media type and reason.");
    }
    titles.add(title.toLowerCase());
    return {
      title,
      body,
      channel,
      strategic_reason,
      media_type: media_type as CampaignIdea["media_type"],
      pillar_id: assignedPillar(item?.pillar_id, pillarIds, title),
      content_format: chosenFormat(item?.content_format, String(media_type), title),
    };
  });
}

/**
 * What the campaign needs built, with a template outranking the model.
 *
 * P3 sends people into a message thread, so it needs something answering —
 * that is what its destination is, not an opinion the model should be asked
 * for. Where there is no template, the model's answer stands, which is how
 * every campaign planned before the library existed still works.
 *
 * Here rather than inline in the job function, because a rule living there
 * can be deleted without a test failing.
 */
export function resolveNeeds(
  template: CampaignTemplate | null,
  submitted: { needs_landing_page: unknown; needs_sales_agent: unknown },
): { needs_landing_page: boolean; needs_sales_agent: boolean } {
  if (template) {
    const needs = derivedNeeds(template);
    return {
      needs_landing_page: needs.needsLandingPage,
      needs_sales_agent: needs.needsSalesAgent,
    };
  }
  return {
    needs_landing_page: submitted.needs_landing_page === true,
    needs_sales_agent: submitted.needs_sales_agent === true,
  };
}
