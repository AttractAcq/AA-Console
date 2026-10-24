/**
 * The Google Ads build a person does by hand.
 *
 * There is no Google Ads adapter in this repository, so for now a paid-Google
 * campaign is built by somebody with Ads Manager access. This agent is what
 * hands them the numbers, derived from the campaign's own package so a hand
 * build and a later automated one cannot disagree about what was intended.
 *
 * Read-only in the two senses `meta_build_sheet` sets out and both matter: it
 * never calls Google — there is no credential read and no transport imported —
 * and it writes nothing but one immutable sheet row and its own job events. In
 * particular it does not touch any external id: those come back from the
 * person who built it.
 *
 * It does not require a usable Google integration. The credential is often
 * exactly what is missing when a hand build is wanted, and a sheet refused
 * because of that would be refused precisely when it is needed.
 *
 * WHAT IT WILL NOT INVENT
 *
 * Keyword research. Turning a service name into "garage conversion
 * portsmouth, exact, 12" and presenting it as a keyword plan is the most
 * expensive kind of plausible output: somebody spends money against it. So
 * groups are seeded from what the campaign actually has — its content
 * pillars, its offer, its geography — every seed is labelled as a seed, and
 * `keyword_research` goes in `missing` until a person has genuinely done it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { logger } from "../../logging/logger.js";

/** Negatives every service business wants, before anybody thinks about it. */
const BASELINE_NEGATIVES = [
  "free",
  "cheap",
  "diy",
  "jobs",
  "vacancy",
  "salary",
  "course",
  "training",
  "wholesale",
  "second hand",
];

export interface SheetCampaign {
  id: string;
  client_id: string;
  name: string;
  objective: string | null;
  audience: string | null;
  daily_budget: number | null;
  target_countries: string[] | null;
  conversion_event: string | null;
  offer_version_id: string | null;
}

export interface DerivedSheet {
  readonly campaign: {
    name: string;
    objective: string | null;
    type: "search";
    daily_budget: number | null;
    monthly_ceiling: number | null;
    geography: string[];
    conversion_action: string | null;
  };
  readonly keyword_groups: {
    name: string;
    seeds: string[];
    match: "phrase";
    note: string;
  }[];
  readonly negatives: string[];
  readonly ads: { headline_source: string; description_source: string; count: number }[];
  readonly destination: { page_id: string | null; url: string | null };
  readonly offer: { version_id: string | null; promise: string | null };
}

function fail(message: string, retryable = false): JobResult {
  return { ok: false, retryable, failureMessage: message };
}

/**
 * Seed groups from what the campaign has, labelled as seeds.
 *
 * A pillar is the closest thing in this system to a theme somebody would
 * search for, and the offer's service name is the other. Both are starting
 * points for research, not research, and the note on each group says so in
 * the sheet itself rather than only here.
 */
export function seedKeywordGroups(
  pillars: string[],
  serviceName: string | null,
  geography: string[],
): DerivedSheet["keyword_groups"] {
  const places = geography.length > 0 ? geography : [];
  const groups: DerivedSheet["keyword_groups"] = [];

  for (const pillar of pillars) {
    groups.push({
      name: pillar,
      seeds: [pillar, ...places.map((place) => `${pillar} ${place}`)],
      match: "phrase",
      note: "Seeded from a campaign content pillar. Not keyword research.",
    });
  }
  if (serviceName) {
    groups.push({
      name: serviceName,
      seeds: [serviceName, ...places.map((place) => `${serviceName} ${place}`)],
      match: "phrase",
      note: "Seeded from the signed offer's service name. Not keyword research.",
    });
  }
  return groups;
}

/** Everything the sheet can say, and a list of what it cannot. */
export function deriveSheet(
  campaign: SheetCampaign,
  context: {
    pillars: string[];
    serviceName: string | null;
    promise: string | null;
    pageId: string | null;
    pageUrl: string | null;
    approvedCopy: number;
  },
): { derived: DerivedSheet; missing: string[] } {
  const geography = campaign.target_countries ?? [];
  const groups = seedKeywordGroups(context.pillars, context.serviceName, geography);

  const derived: DerivedSheet = {
    campaign: {
      name: campaign.name,
      objective: campaign.objective,
      type: "search",
      daily_budget: campaign.daily_budget,
      // Thirty days rather than the calendar month: a ceiling somebody can
      // check against a daily figure without arithmetic.
      monthly_ceiling:
        campaign.daily_budget == null ? null : Math.round(campaign.daily_budget * 30),
      geography,
      conversion_action: campaign.conversion_event,
    },
    keyword_groups: groups,
    negatives: BASELINE_NEGATIVES,
    ads:
      context.approvedCopy > 0
        ? [
            {
              headline_source: "Approved campaign copy",
              description_source: "Approved campaign copy",
              count: context.approvedCopy,
            },
          ]
        : [],
    destination: { page_id: context.pageId, url: context.pageUrl },
    offer: { version_id: campaign.offer_version_id, promise: context.promise },
  };

  const missing: string[] = [];
  // Always. Seeds are not research, and the sheet says so rather than
  // reading as though somebody has done it.
  missing.push("keyword_research");
  if (groups.length === 0) missing.push("themes_to_seed_from");
  if (geography.length === 0) missing.push("geography");
  if (campaign.daily_budget == null) missing.push("daily_budget");
  if (!campaign.conversion_event) missing.push("conversion_action");
  if (!context.pageId) missing.push("landing_page");
  if (context.approvedCopy === 0) missing.push("approved_ad_copy");
  if (!campaign.offer_version_id) missing.push("signed_offer");
  return { derived, missing };
}

/** Human-readable, for the job log a person reads beside the row. */
export function renderSheet(derived: DerivedSheet, missing: string[]): string[] {
  const lines: string[] = [];
  lines.push(
    `Campaign: ${derived.campaign.name} · search · ${derived.campaign.geography.join(", ") || "no geography"}`,
  );
  lines.push(
    `Budget: ${derived.campaign.daily_budget ?? "not set"} daily` +
      (derived.campaign.monthly_ceiling ? ` · ceiling ${derived.campaign.monthly_ceiling}/30 days` : ""),
  );
  lines.push(`Conversion action: ${derived.campaign.conversion_action ?? "not named"}`);
  lines.push(`Destination: ${derived.destination.url ?? "no page attached"}`);
  for (const group of derived.keyword_groups) {
    lines.push(`Group "${group.name}" (${group.match}): ${group.seeds.join(" · ")} — ${group.note}`);
  }
  lines.push(`Negatives (${derived.negatives.length}): ${derived.negatives.join(", ")}`);
  if (missing.length > 0) {
    lines.push(`Still needed before this is a plan: ${missing.join(", ")}.`);
  }
  return lines;
}

export async function runGoogleAdsSheetJob(
  sb: SupabaseClient,
  runtime: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return fail("A build sheet needs the campaign to describe. Start it from the campaign.");
  }

  const { data, error } = await sb
    .from("client_campaigns")
    .select(
      "id, client_id, name, objective, audience, daily_budget, target_countries, conversion_event, offer_version_id, acquisition_mode, paid_platform",
    )
    .eq("id", job.input_id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the campaign: ${error.message}`);
  if (!data) return fail("That campaign no longer exists.");

  const row = data as SheetCampaign & { acquisition_mode: string; paid_platform: string | null };
  if (row.client_id !== job.client_id) {
    return fail("That campaign belongs to a different client.");
  }
  if (row.acquisition_mode !== "paid" || row.paid_platform !== "google") {
    return fail("That campaign is not a paid Google campaign, so there is no Google build to write.");
  }

  // Everything else is context, and a missing piece is a line in the sheet
  // rather than a reason to refuse: the sheet is most wanted when the
  // campaign is least complete.
  const [pillars, page, offer, copy] = await Promise.all([
    sb
      .from("campaign_content_pillars")
      .select("pillar_id, client_content_pillars(name)")
      .eq("campaign_id", row.id),
    sb
      .from("campaign_artifacts")
      .select("page_id, client_pages(published_url)")
      .eq("campaign_id", row.id)
      .eq("kind", "landing_page")
      .limit(1)
      .maybeSingle(),
    row.offer_version_id
      ? sb
          .from("service_offer_versions")
          .select("promise, service_offers(service_name)")
          .eq("id", row.offer_version_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    sb
      .from("campaign_artifacts")
      .select("asset_id, client_media_assets(review_status)")
      .eq("campaign_id", row.id)
      .eq("kind", "content"),
  ]);

  const pillarNames = ((pillars.data ?? []) as { client_content_pillars?: { name?: string } | null }[])
    .map((p) => p.client_content_pillars?.name)
    .filter((name): name is string => Boolean(name));
  const pageRow = (page.data ?? null) as
    | { page_id: string | null; client_pages?: { published_url?: string | null } | null }
    | null;
  const offerRow = (offer.data ?? null) as
    | { promise?: string | null; service_offers?: { service_name?: string | null } | null }
    | null;
  const approvedCopy = ((copy.data ?? []) as {
    client_media_assets?: { review_status?: string } | null;
  }[]).filter((a) => a.client_media_assets?.review_status === "approved").length;

  const { derived, missing } = deriveSheet(row, {
    pillars: pillarNames,
    serviceName: offerRow?.service_offers?.service_name ?? null,
    promise: offerRow?.promise ?? null,
    pageId: pageRow?.page_id ?? null,
    pageUrl: pageRow?.client_pages?.published_url ?? null,
    approvedCopy,
  });

  const { data: sheetId, error: recordError } = await sb.rpc("record_google_ads_sheet_v6", {
    p_campaign_id: row.id,
    p_derived: derived as never,
    p_missing: missing,
    p_job_id: job.id,
  } as never);
  if (recordError) throw new Error(`Could not record the sheet: ${recordError.message}`);

  for (const line of renderSheet(derived, missing)) {
    await appendEvent(sb, job.id, line, "info");
  }
  await appendEvent(
    sb,
    job.id,
    `Sheet recorded. Nothing was sent to Google: there is no adapter, and this agent holds no credential.`,
    "info",
    { sheet_id: sheetId, missing },
  );

  logger.info("google_ads_sheet_written", {
    jobId: job.id,
    campaignId: row.id,
    missing: missing.length,
  });
  void runtime;
  void agent;
  return { ok: true, retryable: false };
}
