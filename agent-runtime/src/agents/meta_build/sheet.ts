/**
 * The same build, written out for a person to type into Ads Manager.
 *
 * The runtime cannot build anything without a Meta token. When there is no
 * usable token — a locked-out login, an expired system user, an account not
 * yet shared with us — the campaign is still fully specified in the console,
 * and somebody who does have Ads Manager access can create the structure by
 * hand. What they must not do is invent the numbers: an objective, an
 * optimisation goal or a special ad category chosen by eye is how a hand-built
 * campaign ends up spending against the wrong goal, or running an undeclared
 * employment ad.
 *
 * So this does not describe the build in its own words. It runs the real
 * payload builders through preflight() and reads the fields back off what
 * would have been sent, which means a sheet cannot say one thing while the
 * automated path does another. The two exceptions are called out where they
 * happen: the daily budget, which is shown in major units because that is
 * what Ads Manager asks for, and the image, which is a storage path rather
 * than an uploaded hash.
 *
 * Nothing here can make anything live either. The sheet says PAUSED at every
 * level, for the same reason the payload builders do.
 */

import { payloadsFor, preflight, type AssetRow, type CampaignRow, type MetaSettings } from "./plan.js";

/**
 * Stand-in for the ids Meta has not issued, matching plan.ts. It appears in
 * no rendered field: it only lets the builders run.
 */
const PENDING = "0";

/**
 * The currency assumed when the account's own is unknown.
 *
 * The real build reads this from Meta at build time and never stores it,
 * because a stored copy that drifted would send a budget a hundred times too
 * large. Without a token there is nothing to read it from, and the only thing
 * the currency decides here is the minor-unit conversion — a number this sheet
 * never prints, because a person types 50, not 5000.
 *
 * A two-decimal default is the safe direction: it accepts every budget a
 * two-decimal account would accept, and the caveat below warns the one case it
 * cannot check, a zero-decimal account such as JPY given a fractional budget.
 */
const ASSUMED_CURRENCY = "USD";

export interface SheetAd {
  assetId: string;
  /** The ad's name in the account, as the runtime would have named it. */
  name: string;
  /** Where the image lives in client-media. It must be uploaded by hand. */
  storagePath: string | null;
  pageId: string;
  primaryText: string;
  headline: string;
  description: string | null;
  link: string;
  /** Meta's own button constant, or null where the template allows none. */
  cta: string | null;
  /** Already built, so it is listed for completeness and not to be made again. */
  alreadyBuilt: boolean;
}

export interface ManualSheet {
  campaignRowId: string;
  /** Campaign level, as Meta's own field names. */
  campaign: {
    name: string;
    objective: string;
    buyingType: string;
    specialAdCategories: readonly string[];
    status: string;
    /** Set when a Meta campaign is already recorded against this row. */
    existingId: string | null;
  };
  adSet: {
    name: string;
    optimisationGoal: string;
    billingEvent: string;
    /** Major units, in the ad account's own currency. Not converted. */
    dailyBudget: number;
    countries: readonly string[];
    startTime: string | null;
    endTime: string | null;
    /** page_id, or pixel_id and the event it counts. */
    promotedObject: Record<string, string> | null;
    status: string;
    existingId: string | null;
  };
  ads: readonly SheetAd[];
  /** Everything the sheet could not establish first-hand, in plain words. */
  caveats: readonly string[];
}

export type SheetResult = { problems: string[]; sheet: null } | { problems: never[]; sheet: ManualSheet };

/**
 * The sheet for one campaign, or every reason there is no sheet to write.
 *
 * The refusals are preflight's own: a campaign that cannot be built by the
 * runtime cannot be built by hand either, and a sheet that papered over a
 * missing page or an unwritten piece of copy would send somebody into Ads
 * Manager to find that out themselves.
 */
export function buildSheet(args: {
  campaign: CampaignRow;
  assets: readonly AssetRow[];
  settings: MetaSettings;
  today: string;
  /** The account's billing currency, when it is known from somewhere else. */
  currency?: string | null;
}): SheetResult {
  const currency = (args.currency ?? "").trim() || ASSUMED_CURRENCY;
  const { problems, inputs } = preflight({
    campaign: args.campaign,
    assets: args.assets,
    settings: args.settings,
    currency,
    today: args.today,
  });
  if (!inputs) return { problems, sheet: null };

  const payloads = payloadsFor(args.campaign, inputs);
  const campaignPayload = payloads.campaign();
  const adSetPayload = payloads.adSet(PENDING);

  const ads: SheetAd[] = inputs.ads.map((asset) => {
    const creative = payloads.creative(asset, PENDING);
    const linkData = creative.object_story_spec.link_data;
    return {
      assetId: asset.id,
      name: payloads.ad(asset, PENDING, PENDING).name,
      storagePath: asset.storage_path,
      pageId: creative.object_story_spec.page_id,
      primaryText: linkData.message,
      headline: linkData.name,
      description: linkData.description ?? null,
      link: linkData.link,
      cta: linkData.call_to_action?.type ?? null,
      alreadyBuilt: Boolean(asset.meta_ad_id),
    };
  });

  const caveats: string[] = [
    "The daily budget is in the ad account's own currency. Type it as it appears here; do not convert it.",
  ];
  if (!args.currency) {
    caveats.push(
      `The account's billing currency was not read from Meta, so a budget finer than one minor unit was checked against ${ASSUMED_CURRENCY}. ` +
        "If the account bills in a currency with no minor unit, such as JPY, check the budget is a whole number.",
    );
  }
  if (ads.some((a) => a.alreadyBuilt)) {
    caveats.push("Ads marked already built exist in the account. Do not create them a second time.");
  }

  return {
    problems: [] as never[],
    sheet: {
      campaignRowId: args.campaign.id,
      campaign: {
        name: campaignPayload.name,
        objective: campaignPayload.objective,
        buyingType: campaignPayload.buying_type,
        specialAdCategories: campaignPayload.special_ad_categories,
        status: campaignPayload.status,
        existingId: args.campaign.meta_campaign_id,
      },
      adSet: {
        name: adSetPayload.name,
        optimisationGoal: adSetPayload.optimization_goal,
        billingEvent: adSetPayload.billing_event,
        // From the row, not the payload: the payload carries minor units.
        dailyBudget: Number(args.campaign.daily_budget),
        countries: args.campaign.target_countries ?? [],
        startTime: adSetPayload.start_time ?? null,
        endTime: adSetPayload.end_time ?? null,
        promotedObject: adSetPayload.promoted_object ?? null,
        status: adSetPayload.status,
        existingId: args.campaign.meta_ad_set_id,
      },
      ads,
      caveats,
    },
  };
}

function line(label: string, value: string): string {
  return `  ${label}: ${value}`;
}

/** One part of the sheet: a heading and the lines under it. */
export interface SheetSection {
  title: string;
  body: readonly string[];
}

/**
 * The sheet in parts, in the order Ads Manager asks for them.
 *
 * Split rather than one block because the job log that carries this to a
 * person stores a description per event and truncates a long one. Sections are
 * also how it stays readable: one campaign, one ad set, one ad at a time.
 *
 * The last section asks for the ids back, because that is the step a hand
 * build skips and the one that matters most afterwards: until the Meta ids are
 * recorded against the console's rows, reporting cannot find the spend, and
 * pressing Build later creates a second campaign beside the first.
 */
export function sheetSections(sheet: ManualSheet): SheetSection[] {
  const sections: SheetSection[] = [];

  const campaignBody = [
    line("Name", sheet.campaign.name),
    line("Objective", sheet.campaign.objective),
    line("Buying type", sheet.campaign.buyingType),
    line(
      "Special ad categories",
      sheet.campaign.specialAdCategories.length > 0
        ? `${sheet.campaign.specialAdCategories.join(", ")} — must be declared`
        : "none",
    ),
    line("Status", sheet.campaign.status),
  ];
  sections.push({
    title: sheet.campaign.existingId ? `Campaign (already exists: ${sheet.campaign.existingId})` : "Campaign",
    body: campaignBody,
  });

  const adSetBody = [
    line("Name", sheet.adSet.name),
    line("Optimisation goal", sheet.adSet.optimisationGoal),
    line("Billing event", sheet.adSet.billingEvent),
    line("Daily budget", `${sheet.adSet.dailyBudget} per day, in the account's own currency`),
    line("Countries", sheet.adSet.countries.join(", ")),
  ];
  if (sheet.adSet.startTime) adSetBody.push(line("Start", sheet.adSet.startTime));
  if (sheet.adSet.endTime) adSetBody.push(line("End", sheet.adSet.endTime));
  if (sheet.adSet.promotedObject) {
    const pairs = Object.entries(sheet.adSet.promotedObject).map(([k, v]) => `${k} ${v}`);
    adSetBody.push(line("Promoted object", pairs.join(", ")));
  }
  adSetBody.push(line("Status", sheet.adSet.status));
  sections.push({
    title: sheet.adSet.existingId ? `Ad set (already exists: ${sheet.adSet.existingId})` : "Ad set",
    body: adSetBody,
  });

  for (const [index, ad] of sheet.ads.entries()) {
    const body = [
      line("Name", ad.name),
      line("Page", ad.pageId),
      line("Image", ad.storagePath ?? "—"),
      line("Primary text", ad.primaryText),
      line("Headline", ad.headline),
    ];
    if (ad.description) body.push(line("Description", ad.description));
    body.push(line("Link", ad.link));
    body.push(line("Call to action", ad.cta ?? "none"));
    body.push(line("Status", "PAUSED"));
    sections.push({ title: `Ad ${index + 1}${ad.alreadyBuilt ? " (already built — skip)" : ""}`, body });
  }

  sections.push({
    title: "Before you leave Ads Manager",
    body: sheet.caveats.map((caveat) => `  - ${caveat}`),
  });

  sections.push({
    title: "Bring these ids back into the console",
    body: [
      "  - The Meta campaign id and the ad set id, onto the campaign.",
      "  - Each ad's creative id and ad id, onto the asset it was made from.",
      "  Until they are recorded, reporting cannot match the spend, and building this campaign " +
        "in Meta later creates a second campaign beside the one you just made.",
    ],
  });

  return sections;
}

/** The whole sheet as one block of text, for a reader that can take it. */
export function renderSheet(sheet: ManualSheet): string {
  const out: string[] = [
    "Manual Meta build — create everything PAUSED. Do not launch anything from this sheet.",
    "",
  ];
  for (const section of sheetSections(sheet)) {
    out.push(section.title, ...section.body, "");
  }
  return out.join("\n").trimEnd();
}
