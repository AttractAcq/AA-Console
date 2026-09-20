/**
 * The sixteen campaign templates, for the screens that pick one.
 *
 * Kept in step with agent-runtime/src/campaigns/templates.ts, which holds the
 * full record and validates what a generator returns. Separate packages, so
 * the list exists twice — this copy carries only what a person choosing one
 * needs to see, and the fields the form writes.
 *
 * Source: the Paid Campaign Matrix. Codes are stored on the campaign row, so
 * renaming one is a migration rather than an edit here.
 */

export const AUDIENCE_STATE_LABEL: Record<string, string> = {
  S0: "Stranger",
  S1: "Watcher",
  S2: "Owned",
  S3: "Identified",
  S4: "In conversation",
  S5: "Customer",
  S6: "Lapsed",
};

export type CampaignFunction = "build" | "spend" | "learn";

export interface CampaignTemplateSummary {
  code: string;
  name: string;
  fn: CampaignFunction;
  entry: string;
  exit: string;
  optimisation: string | null;
  destination: "profile" | "instant_form" | "message" | "page" | "post" | "none";
  purpose: string;
  /** Null means it can run for a client with no history. */
  prerequisite: string | null;
}

export const CAMPAIGN_TEMPLATES: readonly CampaignTemplateSummary[] = [
  { code: "P1", name: "Prospect to follow", fn: "build", entry: "S0", exit: "S2", optimisation: "PROFILE_VISIT", destination: "profile", purpose: "Buys a channel we can reach them through for free, forever.", prerequisite: null },
  { code: "P2", name: "Prospect to direct lead", fn: "build", entry: "S0", exit: "S3", optimisation: "LEAD_GENERATION", destination: "instant_form", purpose: "The fast cycle: skips the nurture where intent is already high.", prerequisite: null },
  { code: "P3", name: "Prospect to DM", fn: "build", entry: "S0", exit: "S3", optimisation: "CONVERSATIONS", destination: "message", purpose: "Lowest-friction identity capture: a conversation costs less than a form.", prerequisite: null },
  { code: "P4", name: "Attention prime", fn: "build", entry: "S0", exit: "S1", optimisation: "THRUPLAY", destination: "none", purpose: "Cheap reach whose only job is filling the pools retargeting spends.", prerequisite: null },
  { code: "P5", name: "Lead magnet", fn: "build", entry: "S0", exit: "S3", optimisation: "LEAD_GENERATION", destination: "page", purpose: "Buys contact details with value rather than with an offer.", prerequisite: "A magnet and the page that gates it." },
  { code: "R1", name: "Retarget to next step", fn: "spend", entry: "S1", exit: "S3", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "The highest return in the account, capped by what P1 and P4 refill.", prerequisite: "P1 or P4 running 14 days or more." },
  { code: "R2", name: "Objection answering", fn: "spend", entry: "S3", exit: "S5", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "One objection per ad, sequenced.", prerequisite: "Leads that did not convert." },
  { code: "R3", name: "Abandon recovery", fn: "spend", entry: "S3", exit: "S4", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "Catches the ones who got most of the way and stopped.", prerequisite: "A pixel recording the step they left." },
  { code: "R4", name: "Proof seeding", fn: "build", entry: "S1", exit: "S1", optimisation: "POST_ENGAGEMENT", destination: "post", purpose: "Loads a post with real comments before it is scaled.", prerequisite: "A post worth seeding." },
  { code: "C1", name: "Customer expansion", fn: "spend", entry: "S5", exit: "S5", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "The cheapest revenue in the account: acquisition is already paid for.", prerequisite: "A customer list." },
  { code: "C2", name: "Reactivation", fn: "spend", entry: "S6", exit: "S5", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "Brings back the ones who bought once and went quiet.", prerequisite: "A lapsed customer list." },
  { code: "C3", name: "Referral", fn: "build", entry: "S5", exit: "S0", optimisation: "LANDING_PAGE_VIEWS", destination: "page", purpose: "Customers introduce strangers at close to no acquisition cost.", prerequisite: "A customer list and something worth referring." },
  { code: "O1", name: "Promotional", fn: "spend", entry: "S2", exit: "S5", optimisation: "OFFSITE_CONVERSIONS", destination: "page", purpose: "The deadline does the work, not the discount.", prerequisite: "A real offer with a real end date." },
  { code: "O2", name: "Event or webinar", fn: "build", entry: "S0", exit: "S3", optimisation: "LEAD_GENERATION", destination: "page", purpose: "A date creates urgency an offer cannot.", prerequisite: "A date." },
  { code: "X1", name: "Lookalike scale", fn: "spend", entry: "S0", exit: "S3", optimisation: null, destination: "page", purpose: "Points a template that works at people like the best pool we own.", prerequisite: "A seed of 100 or more." },
  { code: "X2", name: "Test", fn: "learn", entry: "S0", exit: "S0", optimisation: null, destination: "page", purpose: "Buys information about one creative, audience or offer.", prerequisite: null },
];

export function templateFor(code: string | null | undefined): CampaignTemplateSummary | null {
  const raw = (code ?? "").trim();
  return CAMPAIGN_TEMPLATES.find((t) => t.code === raw) ?? null;
}

/**
 * Options for a picker, with the prerequisite said out loud.
 *
 * A template you cannot run yet stays selectable — a campaign being planned
 * now may well be for next month, and hiding it would turn a sentence the
 * operator can judge into an absence they cannot.
 *
 * The sixteen only. FieldControl renders its own empty option for a select,
 * so a blank here would be the second one in the list and both would set the
 * field to "". A standalone select adds its own.
 */
export function templateOptions(): { value: string; label: string }[] {
  return CAMPAIGN_TEMPLATES.map((t) => ({
    value: t.code,
    label: `${t.code} · ${t.name}${t.prerequisite ? " (needs setup first)" : ""}`,
  }));
}

/** The blank a standalone select needs, since it has no placeholder of its own. */
export const NO_TEMPLATE = { value: "", label: "No template — plan it from the brief" };

/**
 * What the template's destination means must already exist.
 *
 * Mirrors derivedNeeds in the runtime. "Needs" means the campaign requires
 * one, not that one must be built fresh — provisioning recognises a page that
 * is already there.
 */
export function derivedNeeds(template: CampaignTemplateSummary): {
  needs_landing_page: boolean;
  needs_sales_agent: boolean;
} {
  return {
    needs_landing_page: template.destination === "page",
    needs_sales_agent: template.destination === "message",
  };
}

/** The columns a chosen template writes onto the campaign row. */
export function templateColumns(code: string | null | undefined): Record<string, unknown> | null {
  const template = templateFor(code);
  if (!template) return null;
  return {
    template: template.code,
    entry_state: template.entry,
    exit_state: template.exit,
    optimisation_event: template.optimisation,
    ...derivedNeeds(template),
  };
}

/** One line under the picker, so the choice explains itself. */
export function templateSummary(template: CampaignTemplateSummary): string {
  const moves = `${AUDIENCE_STATE_LABEL[template.entry] ?? template.entry} → ${AUDIENCE_STATE_LABEL[template.exit] ?? template.exit}`;
  const needs = derivedNeeds(template);
  const builds = [
    needs.needs_landing_page ? "a landing page" : null,
    needs.needs_sales_agent ? "a sales agent" : null,
  ].filter(Boolean);
  return [
    template.purpose,
    `Moves people ${moves}.`,
    builds.length > 0 ? `Needs ${builds.join(" and ")}.` : null,
    template.prerequisite,
  ]
    .filter(Boolean)
    .join(" ");
}
