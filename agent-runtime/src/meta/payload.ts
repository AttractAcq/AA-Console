/**
 * Turning a campaign template into the objects Meta's Marketing API takes.
 *
 * Pure, and separate from the transport, because everything that can cost
 * real money by being wrong lives here: the budget conversion, the special ad
 * category, and the promoted object. None of it needs a network call to be
 * checked, so none of it is checked by spending.
 *
 * Nothing in this module or in ads.ts can produce an ACTIVE object. Campaigns,
 * ad sets and ads are created paused and are launched by a person in Ads
 * Manager. That is an absence rather than a permission check: there is no
 * argument to pass and no branch to reach.
 */

import type { CampaignTemplate } from "../campaigns/templates.js";

export const PAUSED = "PAUSED" as const;

/**
 * Currencies Meta quotes in whole units.
 *
 * Everything else is quoted in minor units, so R50 is sent as 5000. Sending
 * 50 instead buys a campaign a hundredth of its budget; sending 5000 for a
 * currency on this list buys it a hundred times its budget. The second
 * mistake is the expensive one, which is why this list exists rather than a
 * blanket multiply by 100.
 */
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/**
 * A budget in the units Meta bills in.
 *
 * Throws rather than rounding silently: a half-cent daily budget is a caller
 * bug, and guessing which way the caller meant it to round is how a campaign
 * ends up running at a number nobody chose.
 */
export function minorUnits(amount: number, currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`"${currency}" is not a currency code.`);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`A budget must be a positive amount, not ${amount}.`);
  }
  if (ZERO_DECIMAL.has(code)) {
    if (!Number.isInteger(amount)) {
      throw new Error(`${code} has no minor unit, so ${amount} cannot be sent.`);
    }
    return amount;
  }
  const minor = amount * 100;
  // Floating point: 50.1 * 100 is 5009.999999999999, which is not a bug in
  // the caller's number. Round to the nearest minor unit, then insist the
  // original had no more precision than that.
  const rounded = Math.round(minor);
  if (Math.abs(minor - rounded) > 1e-6) {
    throw new Error(`${amount} ${code} is finer than one minor unit.`);
  }
  return rounded;
}

/**
 * Meta's special ad categories.
 *
 * Employment, housing and credit ads must be declared. This is not a Meta
 * formality — an undeclared employment ad is an undeclared employment ad to a
 * regulator too, and AA runs its own hiring ads through this system.
 *
 * The declaration also removes targeting Meta will not allow on these ads,
 * which is why targetingProblem below refuses age and gender alongside it.
 */
export type SpecialAdCategory = "EMPLOYMENT" | "HOUSING" | "CREDIT";

export function specialAdCategories(purpose: string): SpecialAdCategory[] {
  return purpose === "recruitment" ? ["EMPLOYMENT"] : [];
}

export interface Targeting {
  /** Meta geo targeting, passed through as given. */
  geo_locations: Record<string, unknown>;
  age_min?: number;
  age_max?: number;
  genders?: number[];
  custom_audiences?: { id: string }[];
  excluded_custom_audiences?: { id: string }[];
}

/**
 * Why this targeting cannot be sent, or null if it can.
 *
 * Age and gender on an employment ad are refused here rather than by Meta,
 * because the reason matters: it is anti-discrimination law, and a caller who
 * sees Meta's error is likely to look for a way around it.
 */
export function targetingProblem(
  targeting: Targeting,
  categories: readonly SpecialAdCategory[],
): string | null {
  if (!targeting.geo_locations || Object.keys(targeting.geo_locations).length === 0) {
    return "An ad set needs somewhere to run: geo_locations is empty.";
  }
  if (categories.length === 0) return null;

  const narrowed: string[] = [];
  if (targeting.age_min !== undefined || targeting.age_max !== undefined) narrowed.push("age");
  if (targeting.genders !== undefined) narrowed.push("gender");
  if (narrowed.length > 0) {
    return `An ad in the ${categories.join(", ")} category cannot be targeted by ${narrowed.join(" or ")}.`;
  }
  return null;
}

/** What the optimisation goal needs attached to it, beyond the targeting. */
export interface PromotedIds {
  pageId?: string | null;
  pixelId?: string | null;
  /** The pixel event a conversion campaign counts, e.g. Lead or Purchase. */
  conversionEvent?: string | null;
}

/**
 * The promoted_object for an optimisation goal, or a problem describing what
 * is missing.
 *
 * Meta rejects an ad set whose goal needs a promoted object it did not get,
 * but only after the campaign above it has been created — which leaves a
 * half-built structure in the account. Cheaper to refuse here.
 */
export function promotedObject(
  goal: string,
  ids: PromotedIds,
): { value: Record<string, string> | null } | { problem: string } {
  const page = (ids.pageId ?? "").trim();
  const pixel = (ids.pixelId ?? "").trim();
  const event = (ids.conversionEvent ?? "").trim();

  switch (goal) {
    case "LEAD_GENERATION":
    case "CONVERSATIONS":
    case "PROFILE_VISIT":
      if (!page) return { problem: `${goal} needs the Facebook page it runs from.` };
      return { value: { page_id: page } };

    case "OFFSITE_CONVERSIONS":
      if (!pixel) return { problem: `${goal} needs a pixel to count conversions against.` };
      if (!event) {
        return { problem: `${goal} needs the event it counts, such as Lead or Purchase.` };
      }
      return { value: { pixel_id: pixel, custom_event_type: event } };

    case "LANDING_PAGE_VIEWS":
      if (!pixel) return { problem: `${goal} needs a pixel to see the landing page load.` };
      return { value: { pixel_id: pixel } };

    case "THRUPLAY":
    case "POST_ENGAGEMENT":
      return { value: null };

    default:
      return { problem: `${goal} is not an optimisation goal this builds for.` };
  }
}

export interface CampaignPayload {
  name: string;
  objective: string;
  status: typeof PAUSED;
  special_ad_categories: SpecialAdCategory[];
  buying_type: "AUCTION";
}

/**
 * The campaign object.
 *
 * `objective` comes from the template, or from the template it mirrors. X1 and
 * X2 have none of their own, which is why resolution happens before this is
 * called rather than inside it.
 */
export function campaignPayload(args: {
  name: string;
  objective: string;
  purpose: string;
}): CampaignPayload {
  const name = args.name.trim();
  if (!name) throw new Error("A campaign needs a name.");
  return {
    name,
    objective: args.objective,
    status: PAUSED,
    special_ad_categories: specialAdCategories(args.purpose),
    buying_type: "AUCTION",
  };
}

export interface AdSetPayload {
  name: string;
  campaign_id: string;
  optimization_goal: string;
  billing_event: "IMPRESSIONS";
  daily_budget: number;
  targeting: Targeting;
  status: typeof PAUSED;
  start_time?: string;
  end_time?: string;
  promoted_object?: Record<string, string>;
}

export function adSetPayload(args: {
  name: string;
  campaignId: string;
  template: CampaignTemplate;
  optimisationGoal: string;
  dailyBudget: number;
  currency: string;
  targeting: Targeting;
  purpose: string;
  ids: PromotedIds;
  startTime?: string | null;
  endTime?: string | null;
}): AdSetPayload {
  const name = args.name.trim();
  if (!name) throw new Error("An ad set needs a name.");

  const categories = specialAdCategories(args.purpose);
  const targetingIssue = targetingProblem(args.targeting, categories);
  if (targetingIssue) throw new Error(targetingIssue);

  const promoted = promotedObject(args.optimisationGoal, args.ids);
  if ("problem" in promoted) throw new Error(promoted.problem);

  return {
    name,
    campaign_id: args.campaignId,
    optimization_goal: args.optimisationGoal,
    billing_event: "IMPRESSIONS",
    daily_budget: minorUnits(args.dailyBudget, args.currency),
    targeting: args.targeting,
    status: PAUSED,
    ...(args.startTime ? { start_time: args.startTime } : {}),
    ...(args.endTime ? { end_time: args.endTime } : {}),
    ...(promoted.value ? { promoted_object: promoted.value } : {}),
  };
}

export interface AdPayload {
  name: string;
  adset_id: string;
  creative: { creative_id: string };
  status: typeof PAUSED;
}

export function adPayload(args: {
  name: string;
  adSetId: string;
  creativeId: string;
}): AdPayload {
  const name = args.name.trim();
  if (!name) throw new Error("An ad needs a name.");
  if (!args.creativeId.trim()) throw new Error("An ad needs a creative.");
  return {
    name,
    adset_id: args.adSetId,
    creative: { creative_id: args.creativeId.trim() },
    status: PAUSED,
  };
}
