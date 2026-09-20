/**
 * The campaign templates, as data.
 *
 * A campaign's strategy used to be prose: client_campaigns.objective is free
 * text and the planner wrote a fresh sentence every time. Prose cannot be
 * checked, cannot be sequenced, and cannot be turned into a Meta campaign —
 * "grow awareness among local families" does not name an objective the
 * Marketing API accepts or an event it can optimise for.
 *
 * These sixteen are the library the planner picks from instead. The model
 * still decides which template fits and writes the client-specific parts; it
 * no longer invents the machinery underneath.
 *
 * Source: the Paid Campaign Matrix. Codes are stable and are stored on the
 * campaign row, so renaming one is a migration, not an edit.
 */

import { META_CTAS, type MetaCta } from "../meta/cta.js";

/** Where somebody stands with the business. */
export const AUDIENCE_STATES = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type AudienceState = (typeof AUDIENCE_STATES)[number];

export const AUDIENCE_STATE_LABEL: Record<AudienceState, string> = {
  S0: "Stranger",
  S1: "Watcher",
  S2: "Owned",
  S3: "Identified",
  S4: "In conversation",
  S5: "Customer",
  S6: "Lapsed",
};

/**
 * What the campaign does to the asset base.
 *
 * The distinction the whole library turns on: build adds people to a pool,
 * spend converts one, learn buys information. An account that only spends
 * reports excellent numbers until the pool runs out.
 */
export type CampaignFunction = "build" | "spend" | "learn";

/** Meta's ODAX objectives. */
export const META_OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
] as const;
export type MetaObjective = (typeof META_OBJECTIVES)[number];

/**
 * What the ad set optimises for.
 *
 * Kept separate from the objective because this is the field that decides who
 * the ad is shown to, and picking the cheap event is how an account fills up
 * with leads nobody can sell to. An objective of OUTCOME_LEADS optimised for
 * LINK_CLICKS buys clicks, not leads.
 */
export const OPTIMISATION_GOALS = [
  "CONVERSATIONS",
  "LANDING_PAGE_VIEWS",
  "LEAD_GENERATION",
  "OFFSITE_CONVERSIONS",
  "POST_ENGAGEMENT",
  "PROFILE_VISIT",
  "THRUPLAY",
] as const;
export type OptimisationGoal = (typeof OPTIMISATION_GOALS)[number];

/** Where the click goes, which is what decides the legal CTA set. */
export type Destination = "profile" | "instant_form" | "message" | "page" | "post" | "none";

export interface CampaignTemplate {
  code: string;
  name: string;
  fn: CampaignFunction;
  entry: AudienceState;
  exit: AudienceState;
  /** Null on a template that mirrors another; it inherits what it scales. */
  objective: MetaObjective | null;
  optimisation: OptimisationGoal | null;
  /** Allowed buttons, most apt first. Empty where the template runs without one. */
  ctas: readonly MetaCta[];
  destination: Destination;
  kpi: string;
  /** Why it exists, in one line. */
  purpose: string;
  /** The mistake this template invites, stated so the builder can avoid it. */
  guardrail: string;
  /**
   * What must already be true. Null means it can run from a standing start.
   *
   * Not enforced here — nothing yet records which campaign built which pool.
   * Stated so a plan that ignores it can be argued with.
   */
  prerequisite: string | null;
  /** Takes its objective, optimisation and CTA from the template it points at. */
  mirrors: boolean;
}

export const CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  {
    code: "P1",
    name: "Prospect to follow",
    fn: "build",
    entry: "S0",
    exit: "S2",
    objective: "OUTCOME_ENGAGEMENT",
    optimisation: "PROFILE_VISIT",
    ctas: ["LEARN_MORE"],
    destination: "profile",
    kpi: "Cost per engaged follower at 30 days",
    purpose: "Buys a channel we can reach them through for free, forever.",
    guardrail:
      "Page-likes optimisation buys followers who never come back. Score engaged followers, not the count.",
    prerequisite: null,
    mirrors: false,
  },
  {
    code: "P2",
    name: "Prospect to direct lead",
    fn: "build",
    entry: "S0",
    exit: "S3",
    objective: "OUTCOME_LEADS",
    optimisation: "LEAD_GENERATION",
    ctas: ["SIGN_UP", "BOOK_NOW", "GET_QUOTE"],
    destination: "instant_form",
    kpi: "Cost per lead and lead-to-booked rate, together",
    purpose: "The fast cycle: skips the nurture where intent is already high.",
    guardrail:
      "Cost per lead on its own rewards junk. A form with no qualifying question halves quality.",
    prerequisite: null,
    mirrors: false,
  },
  {
    code: "P3",
    name: "Prospect to DM",
    fn: "build",
    entry: "S0",
    exit: "S3",
    objective: "OUTCOME_ENGAGEMENT",
    optimisation: "CONVERSATIONS",
    ctas: ["SEND_MESSAGE"],
    destination: "message",
    kpi: "Cost per replied conversation",
    purpose: "Lowest-friction identity capture: a conversation costs less than a form.",
    guardrail: "Worthless without something answering out of hours. Check that before spending.",
    prerequisite: null,
    mirrors: false,
  },
  {
    code: "P4",
    name: "Attention prime",
    fn: "build",
    entry: "S0",
    exit: "S1",
    objective: "OUTCOME_AWARENESS",
    optimisation: "THRUPLAY",
    ctas: [],
    destination: "none",
    kpi: "Cost per 15-second view, and pool size",
    purpose: "Cheap reach whose only job is filling the pools the retargeting templates spend.",
    guardrail: "Deliberately no CTA. Asking for the click here defeats the purpose.",
    prerequisite: null,
    mirrors: false,
  },
  {
    code: "P5",
    name: "Lead magnet",
    fn: "build",
    entry: "S0",
    exit: "S3",
    objective: "OUTCOME_LEADS",
    optimisation: "LEAD_GENERATION",
    ctas: ["DOWNLOAD", "SIGN_UP"],
    destination: "page",
    kpi: "Cost per lead that opened the asset",
    purpose: "Buys contact details with value rather than with an offer.",
    guardrail:
      "A magnet nobody opens produced contact details, not interest. Never score on leads captured.",
    prerequisite: "A magnet and the page that gates it.",
    mirrors: false,
  },
  {
    code: "R1",
    name: "Retarget to next step",
    fn: "spend",
    entry: "S1",
    exit: "S3",
    objective: "OUTCOME_LEADS",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["BOOK_NOW", "SHOP_NOW", "LEARN_MORE"],
    destination: "page",
    kpi: "Return on ad spend, and how fast the pool is drawn down",
    purpose: "The highest return in the account, capped by whatever P1 and P4 refill.",
    guardrail: "Cannot outrun what feeds it. Watch frequency above 3.",
    prerequisite: "P1 or P4 running 14 days or more.",
    mirrors: false,
  },
  {
    code: "R2",
    name: "Objection answering",
    fn: "spend",
    entry: "S3",
    exit: "S5",
    objective: "OUTCOME_SALES",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["BOOK_NOW", "LEARN_MORE"],
    destination: "page",
    kpi: "Close rate across the sequence",
    purpose: "One objection per ad, sequenced. Where the proof bank earns its keep.",
    guardrail: "An ad answering three objections answers none of them.",
    prerequisite: "Leads that did not convert.",
    mirrors: false,
  },
  {
    code: "R3",
    name: "Abandon recovery",
    fn: "spend",
    entry: "S3",
    exit: "S4",
    objective: "OUTCOME_SALES",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["BOOK_NOW"],
    destination: "page",
    kpi: "Recovery rate",
    purpose: "Catches the ones who got most of the way and stopped.",
    guardrail: "One to three days, then stop. Past a week it is just annoying.",
    prerequisite: "A pixel recording the step they left.",
    mirrors: false,
  },
  {
    code: "R4",
    name: "Proof seeding",
    fn: "build",
    entry: "S1",
    exit: "S1",
    objective: "OUTCOME_ENGAGEMENT",
    optimisation: "POST_ENGAGEMENT",
    ctas: [],
    destination: "post",
    kpi: "Comments per pound",
    purpose: "Loads a post with real comments before it is scaled.",
    guardrail: "Scale the same post by ID afterwards, or the proof does not carry over.",
    prerequisite: "A post worth seeding.",
    mirrors: false,
  },
  {
    code: "C1",
    name: "Customer expansion",
    fn: "spend",
    entry: "S5",
    exit: "S5",
    objective: "OUTCOME_SALES",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["SHOP_NOW", "BOOK_NOW"],
    destination: "page",
    kpi: "Revenue per existing customer reached",
    purpose: "The cheapest revenue in the account: the acquisition is already paid for.",
    guardrail: "Exclude anyone mid-purchase.",
    prerequisite: "A customer list.",
    mirrors: false,
  },
  {
    code: "C2",
    name: "Reactivation",
    fn: "spend",
    entry: "S6",
    exit: "S5",
    objective: "OUTCOME_SALES",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["GET_OFFER", "BOOK_NOW"],
    destination: "page",
    kpi: "Reactivation rate",
    purpose: "Brings back the ones who bought once and went quiet.",
    guardrail: "Needs a reason the gap should end. \"We miss you\" is not one.",
    prerequisite: "A lapsed customer list.",
    mirrors: false,
  },
  {
    code: "C3",
    name: "Referral",
    fn: "build",
    entry: "S5",
    exit: "S0",
    objective: "OUTCOME_TRAFFIC",
    optimisation: "LANDING_PAGE_VIEWS",
    ctas: ["LEARN_MORE"],
    destination: "page",
    kpi: "Referrals per customer reached",
    purpose: "Customers introduce strangers at close to no acquisition cost.",
    guardrail: "Customers only, and a small budget. The audience is tiny by definition.",
    prerequisite: "A customer list and something worth referring.",
    mirrors: false,
  },
  {
    code: "O1",
    name: "Promotional",
    fn: "spend",
    entry: "S2",
    exit: "S5",
    objective: "OUTCOME_SALES",
    optimisation: "OFFSITE_CONVERSIONS",
    ctas: ["GET_OFFER", "SHOP_NOW"],
    destination: "page",
    kpi: "Revenue inside the window",
    purpose: "The deadline does the work, not the discount.",
    guardrail: "A deadline that moves never works again. People learn it in one cycle.",
    prerequisite: "A real offer with a real end date.",
    mirrors: false,
  },
  {
    code: "O2",
    name: "Event or webinar",
    fn: "build",
    entry: "S0",
    exit: "S3",
    objective: "OUTCOME_LEADS",
    optimisation: "LEAD_GENERATION",
    ctas: ["SIGN_UP"],
    destination: "page",
    kpi: "Attendance, not registrations",
    purpose: "A date creates urgency an offer cannot.",
    guardrail: "Registrations are free to give and free to skip. Optimising to them fills an empty room.",
    prerequisite: "A date.",
    mirrors: false,
  },
  {
    code: "X1",
    name: "Lookalike scale",
    fn: "spend",
    entry: "S0",
    exit: "S3",
    objective: null,
    optimisation: null,
    ctas: [],
    destination: "page",
    kpi: "Cost per acquisition against the template it scales",
    purpose: "Takes a template that works and points it at people like the best pool we own.",
    guardrail: "A 1% lookalike seeded on customers beats a 5% seeded on visitors.",
    prerequisite: "A seed of 100 or more, ideally 1,000.",
    mirrors: true,
  },
  {
    code: "X2",
    name: "Test",
    fn: "learn",
    entry: "S0",
    exit: "S0",
    objective: null,
    optimisation: null,
    ctas: [],
    destination: "page",
    kpi: "Confidence, not cost per acquisition",
    purpose: "Buys information about one creative, audience or offer.",
    guardrail: "One variable, a fixed budget, and it stops on the date rather than on a feeling.",
    prerequisite: null,
    mirrors: true,
  },
];

export const TEMPLATE_CODES: readonly string[] = CAMPAIGN_TEMPLATES.map((t) => t.code);

export function templateFor(code: string): CampaignTemplate | null {
  return CAMPAIGN_TEMPLATES.find((t) => t.code === code) ?? null;
}

/** Templates that can run for a client with no history. */
export function availableFromStart(): readonly CampaignTemplate[] {
  return CAMPAIGN_TEMPLATES.filter((t) => t.prerequisite === null);
}

/**
 * Why this template cannot be built as asked, or null if it can.
 *
 * Two rules, and both are about a campaign the Marketing API would reject or
 * silently misbuild rather than about taste:
 *
 * A mirroring template has no objective of its own, so it must name the one
 * it scales — a lookalike of nothing is broad targeting with extra steps, and
 * there is no objective to send.
 *
 * A CTA has to be one the destination can serve. SEND_MESSAGE needs a message
 * thread to open; Meta rejects it on a link ad, and a template offering both
 * would let the planner pick the invalid pair.
 */
export function templateProblem(
  template: CampaignTemplate,
  chosen: { cta?: string | null; mirrorOf?: string | null },
): string | null {
  if (template.mirrors) {
    const source = (chosen.mirrorOf ?? "").trim();
    if (!source) {
      return `${template.code} takes its objective from the template it scales, so it must name one.`;
    }
    const target = templateFor(source);
    if (!target) return `${source} is not a campaign template.`;
    if (target.mirrors) {
      return `${template.code} cannot mirror ${source}, which has no objective of its own.`;
    }
  }

  const cta = (chosen.cta ?? "").trim();
  if (cta) {
    if (!(META_CTAS as readonly string[]).includes(cta)) {
      return `"${cta}" is not a Meta call-to-action button.`;
    }
    if (!template.mirrors && template.ctas.length === 0) {
      return `${template.code} runs without a call-to-action button.`;
    }
    if (!template.mirrors && !(template.ctas as readonly string[]).includes(cta)) {
      return `${cta} cannot point at ${template.destination}. ${template.code} allows: ${template.ctas.join(", ")}.`;
    }
  }

  return null;
}

/**
 * What a template's destination means must exist before the campaign can run.
 *
 * The planner used to decide these by asking the model, which is a judgement
 * call the template has already made: P3 sends people into a message thread,
 * so it needs something answering — that is what its destination *is*, not an
 * opinion about it. R1 points at a page, so a page has to exist.
 *
 * "Needs" means the campaign requires one, not that one must be built fresh.
 * Provisioning already recognises a page that is there and creates nothing.
 */
export function derivedNeeds(template: CampaignTemplate): {
  needsLandingPage: boolean;
  needsSalesAgent: boolean;
} {
  return {
    needsLandingPage: template.destination === "page",
    needsSalesAgent: template.destination === "message",
  };
}
