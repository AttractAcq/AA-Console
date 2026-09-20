/**
 * Whether a campaign has the pool it intends to spend.
 *
 * A spend template converts an audience somebody else's budget built. R1 can
 * only be as big as what P1 and P4 refill, and an account that runs only
 * spend campaigns reports excellent numbers for about six weeks and then
 * stalls, because nothing in it makes new people.
 *
 * These are warnings, not refusals. A campaign planned today may be for next
 * month, and an operator who knows the pool exists outside our records should
 * not be stopped by us — so this says what is missing and lets them decide.
 */

import { templateFor, type CampaignTemplate } from "./templates.js";

/** How long a build campaign needs to run before there is a pool worth spending. */
export const POOL_DAYS = 14;

export interface CampaignRow {
  id: string;
  template: string | null;
  feedsFromCampaignId: string | null;
}

export interface FeederRow {
  id: string;
  template: string | null;
  /** When it was built at Meta. Null means it never was. */
  builtAt: string | null;
}

export function isSpendTemplate(template: CampaignTemplate | null): boolean {
  return template?.fn === "spend";
}

/**
 * What is wrong with this campaign's pool, or null if nothing is.
 *
 * `now` is passed rather than read so the fourteen-day rule is testable
 * without waiting fourteen days.
 */
export function poolWarning(
  campaign: CampaignRow,
  feeder: FeederRow | null,
  now: Date,
): string | null {
  const template = templateFor(campaign.template ?? "");
  if (!template) return null;
  if (!isSpendTemplate(template)) return null;

  if (!campaign.feedsFromCampaignId) {
    return `${template.code} spends an audience another campaign builds, and none is named. ${template.prerequisite ?? ""}`.trim();
  }
  if (!feeder) {
    return "The campaign this one was set to spend is no longer there.";
  }

  const feederTemplate = templateFor(feeder.template ?? "");
  if (feederTemplate && feederTemplate.fn === "spend") {
    return `${feederTemplate.code} spends a pool rather than building one, so it cannot fill ${template.code}.`;
  }

  if (!feeder.builtAt) {
    return "The campaign this one spends has not been built yet, so there is no audience in it.";
  }

  const days = Math.floor((now.getTime() - new Date(feeder.builtAt).getTime()) / 86_400_000);
  // A built date we cannot read is not the same as a pool that is old
  // enough. Falling through would return no warning, which says the pool is
  // fine — and we have no idea whether it is.
  if (Number.isNaN(days)) {
    return "The campaign this one spends has an unreadable build date, so there is no telling how long it has been running.";
  }
  if (days < POOL_DAYS) {
    const left = POOL_DAYS - days;
    return `The campaign this one spends has been running ${days} day${days === 1 ? "" : "s"}. A pool is usually worth spending after ${POOL_DAYS}; ${left} to go.`;
  }
  return null;
}
