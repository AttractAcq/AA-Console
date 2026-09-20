/**
 * Onboarding: the one place a client's information is first collected.
 *
 * It used to be three checkboxes somebody ticked by hand. Nothing was
 * collected, nothing downstream knew whether it had been, and a client could
 * be fully "onboarded" with an empty business context — which is how agents
 * end up writing cautious output nobody can account for.
 *
 * TWO DECISIONS SHAPE THIS FILE.
 *
 * First: onboarding writes to the SAME tables the rest of the app reads.
 * There is no onboarding-specific store and no sync. Contact details entered
 * here are client_contact_details, which is what Contact & Identity renders;
 * the business step is client_business_context, which is what every agent
 * reads. "Sticky" is therefore a property of the schema rather than a job
 * that has to keep running, and it cannot drift because there is only one
 * copy.
 *
 * Second: a step's status is DERIVED from that data, never stored. A stored
 * status is a claim; derived status is the thing itself. It also means a step
 * completed from its own panel later — somebody filling in Brand & Design
 * directly — shows as complete here without anybody telling onboarding.
 */

export type StepKey = "contact" | "business" | "brand" | "credentials" | "call";

export interface OnboardingStep {
  key: StepKey;
  title: string;
  /** What this unlocks, in the operator's terms — why it is worth filling in. */
  why: string;
  /** Where the same data lives, so it can be edited later. Path after /clients/:id/. */
  livesAt: { label: string; path: string };
  /** A step with no data behind it is ticked by hand. Only the call is. */
  manual?: boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: "contact",
    title: "Contact & identity",
    why: "Who we speak to, and the website and handles every other step reads. The Proof Finder and the business researcher cannot start without the website.",
    livesAt: { label: "Contact & Identity", path: "account/contact" },
  },
  {
    key: "business",
    title: "The business",
    why: "What they do, who for, what they sell and who else the buyer considers. Every agent reads this — thin answers here make cautious output everywhere.",
    // Not under /account like the others — Business Context lives in the
    // Delivery section, so the whole path is given rather than a tab name.
    livesAt: { label: "Intelligence → Business Context", path: "delivery/intelligence?tab=business-context" },
  },
  {
    key: "brand",
    title: "Brand & design",
    why: "Colours, type and what the imagery must never do. Creative builds read this, and without it every asset comes back in a default palette.",
    livesAt: { label: "Brand & Design", path: "account/brand" },
  },
  {
    key: "credentials",
    title: "Credentials",
    why: "Meta and Instagram access, so reporting and attribution have numbers to pull rather than a blank dashboard.",
    livesAt: { label: "Integrations", path: "account/integrations" },
  },
  {
    key: "call",
    title: "Onboarding call",
    why: "The conversation that fills the gaps the forms cannot. Ticked by hand — there is no record of it to read.",
    livesAt: { label: "Onboarding", path: "account/onboarding" },
    manual: true,
  },
];

/** What the app has on file, as the panel loads it. */
export interface OnboardingData {
  contact: Record<string, unknown> | null;
  business: Record<string, unknown> | null;
  brand: Record<string, unknown> | null;
  integrations: { provider: string }[];
  /** Manual ticks, still stored because there is nothing else to derive from. */
  manualComplete: StepKey[];
}

function filled(row: Record<string, unknown> | null, field: string): boolean {
  const value = row?.[field];
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

/**
 * The fields a step needs before it counts as done.
 *
 * Deliberately a subset. Onboarding asks for more than this, because more is
 * useful, but a step is not held open for a field nothing depends on. The
 * bar is "the app can now do its job", not "the form is full".
 */
const REQUIRED: Record<Exclude<StepKey, "call" | "credentials">, string[]> = {
  contact: ["primary_contact", "website"],
  business: ["business_overview", "ideal_customer", "main_offer", "competitors"],
  brand: ["colour_primary", "imagery_style"],
};

/** The providers that actually sync. Storing a Resend key is not onboarding. */
export const SYNCING_PROVIDERS = ["meta", "instagram"] as const;

export type StepState = "done" | "partial" | "empty";

/** What is still missing from a step, in the field names the form uses. */
export function missingFor(key: StepKey, data: OnboardingData): string[] {
  if (key === "call") return data.manualComplete.includes("call") ? [] : ["the call"];
  if (key === "credentials") {
    const have = new Set(data.integrations.map((i) => i.provider));
    return SYNCING_PROVIDERS.filter((p) => !have.has(p));
  }
  const row = key === "contact" ? data.contact : key === "business" ? data.business : data.brand;
  return REQUIRED[key].filter((field) => !filled(row, field));
}

/**
 * Where a step stands.
 *
 * `partial` matters: a client with a website but no primary contact is not
 * "not started", and showing it as empty loses the work somebody already did.
 */
export function stepState(key: StepKey, data: OnboardingData): StepState {
  const missing = missingFor(key, data);
  if (missing.length === 0) return "done";
  if (key === "call") return "empty";

  if (key === "credentials") {
    return missing.length < SYNCING_PROVIDERS.length ? "partial" : "empty";
  }
  const required = REQUIRED[key as Exclude<StepKey, "call" | "credentials">];
  return missing.length < required.length ? "partial" : "empty";
}

/** Steps done, out of all of them. */
export function progress(data: OnboardingData): { done: number; total: number } {
  return {
    done: ONBOARDING_STEPS.filter((s) => stepState(s.key, data) === "done").length,
    total: ONBOARDING_STEPS.length,
  };
}

/**
 * The first step still worth opening.
 *
 * Partial before empty, because a half-filled step is usually the one
 * somebody was in the middle of.
 */
export function nextStep(data: OnboardingData): OnboardingStep | null {
  return (
    ONBOARDING_STEPS.find((s) => stepState(s.key, data) === "partial") ??
    ONBOARDING_STEPS.find((s) => stepState(s.key, data) === "empty") ??
    null
  );
}
