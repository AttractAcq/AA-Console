/**
 * Everything a Meta build decides before it touches the ad account.
 *
 * Pure, so every refusal can be checked without a network call. The rule is
 * that a build either can finish or stops here: Meta rejecting the ad set
 * after the campaign above it was created leaves a half-built structure in
 * somebody's account, and nothing in this file needs Meta to know that the
 * ad set was going to be rejected.
 *
 * The checks are the payload builders' own. Each builder is run once with a
 * stand-in for the id Meta has not issued yet, and whatever it throws is a
 * preflight problem. A second copy of those rules here would drift from the
 * one that actually sends.
 */

import {
  templateFor,
  templateProblem,
  type CampaignTemplate,
} from "../../campaigns/templates.js";
import { adCreativePayload, type AdCopy } from "../../meta/creative.js";
import {
  adPayload,
  adSetPayload,
  campaignPayload,
  type AdPayload,
  type AdSetPayload,
  type CampaignPayload,
} from "../../meta/payload.js";
import type { AssetState, BuiltState } from "../../meta/build.js";

export interface CampaignRow {
  id: string;
  name: string;
  template: string | null;
  mirrors_template: string | null;
  optimisation_event: string | null;
  conversion_event: string | null;
  daily_budget: number | string | null;
  target_countries: string[] | null;
  starts_on: string | null;
  ends_on: string | null;
  meta_campaign_id: string | null;
  meta_ad_set_id: string | null;
}

export interface AssetRow {
  id: string;
  title: string | null;
  media_type: string;
  /** single, carousel or story. A carousel is several frames, not one image. */
  content_format: string | null;
  storage_path: string | null;
  review_status: string;
  purpose: string | null;
  ad_primary_text: string | null;
  ad_headline: string | null;
  ad_description: string | null;
  ad_link_url: string | null;
  ad_cta: string | null;
  meta_image_hash: string | null;
  meta_creative_id: string | null;
  meta_ad_id: string | null;
}

export interface MetaSettings {
  pageId: string | null;
  pixelId: string | null;
}

/** What the template resolves to once a mirroring template has borrowed its source's machinery. */
export interface ResolvedSpec {
  template: CampaignTemplate;
  objective: string;
  optimisation: string;
}

/**
 * Destinations this can build today.
 *
 * Only a link ad pointing at a page. The others each need a creative shape
 * the library does not build — a lead form id, a message thread, an
 * existing post — and building a link ad for them anyway would either be
 * rejected by Meta or, worse, run and send people somewhere useless.
 */
const BUILDABLE_DESTINATIONS = new Set(["page"]);

/** Stand-in for ids Meta has not issued yet, used only to run the builders. */
const PENDING = "0";

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether an asset is meant to be an ad.
 *
 * Writing copy on an approved asset is what puts it in a build. An approved
 * picture with no words is content, not an ad, and is left out rather than
 * refused — a campaign may carry organic pieces beside its paid ones.
 */
export function isAdCandidate(asset: AssetRow): boolean {
  return (
    asset.review_status === "approved" &&
    hasText(asset.storage_path) &&
    [asset.ad_primary_text, asset.ad_headline, asset.ad_link_url, asset.ad_cta].some(hasText)
  );
}

export function copyOf(asset: AssetRow): AdCopy {
  return {
    primaryText: asset.ad_primary_text ?? "",
    headline: asset.ad_headline ?? "",
    description: asset.ad_description,
    link: asset.ad_link_url ?? "",
    cta: asset.ad_cta,
  };
}

function assetLabel(asset: AssetRow): string {
  return asset.title?.trim() ? `"${asset.title.trim()}"` : `Asset ${asset.id}`;
}

/** The campaign's template, with a mirroring one resolved to what it scales. */
export function resolveSpec(campaign: CampaignRow): ResolvedSpec | { problem: string } {
  const code = (campaign.template ?? "").trim();
  if (!code) {
    return { problem: "This campaign has no template, so there is no Meta objective to build it with." };
  }
  const template = templateFor(code);
  if (!template) return { problem: `${code} is not a campaign template.` };

  const mirrored = templateProblem(template, { mirrorOf: campaign.mirrors_template });
  if (mirrored) return { problem: mirrored };

  if (!BUILDABLE_DESTINATIONS.has(template.destination)) {
    return {
      problem:
        `${template.code} (${template.name}) sends people to ${template.destination.replace("_", " ")}. ` +
        "Only templates that point at a page can be built in Meta so far.",
    };
  }

  const source = template.mirrors ? templateFor(campaign.mirrors_template ?? "") : template;
  const objective = source?.objective ?? null;
  // The campaign may carry its own event where the planner narrowed it; the
  // template's is the default.
  const optimisation = hasText(campaign.optimisation_event)
    ? campaign.optimisation_event!.trim()
    : source?.optimisation ?? null;
  if (!objective || !optimisation) {
    return { problem: `${template.code} has no objective or optimisation goal to build with.` };
  }
  return { template, objective, optimisation };
}

/**
 * The special-ad-category purpose. Any hiring asset makes the whole
 * campaign an employment campaign: Meta declares the category on the
 * campaign, and an undeclared hiring ad is an undeclared hiring ad however
 * many other ads sit beside it.
 */
export function purposeOf(assets: readonly AssetRow[]): string {
  return assets.some((a) => a.purpose === "recruitment") ? "recruitment" : "content";
}

export interface BuildInputs {
  spec: ResolvedSpec;
  /** YYYY-MM-DD. A start date already behind it is not sent; the ad set starts when launched. */
  today: string;
  currency: string;
  settings: MetaSettings;
  /** The assets that become ads, already checked. */
  ads: AssetRow[];
  purpose: string;
}

export interface Payloads {
  campaign: () => CampaignPayload;
  adSet: (campaignId: string) => AdSetPayload;
  creative: (asset: AssetRow, imageHash: string) => ReturnType<typeof adCreativePayload>;
  ad: (asset: AssetRow, adSetId: string, creativeId: string) => AdPayload;
}

export function payloadsFor(campaign: CampaignRow, inputs: BuildInputs): Payloads {
  const { spec, currency, settings, purpose, today } = inputs;
  const name = campaign.name.trim();
  return {
    campaign: () => campaignPayload({ name, objective: spec.objective, purpose }),
    adSet: (campaignId) =>
      adSetPayload({
        name: `${name} — ad set`,
        campaignId,
        template: spec.template,
        optimisationGoal: spec.optimisation,
        dailyBudget: Number(campaign.daily_budget),
        currency,
        targeting: { geo_locations: { countries: campaign.target_countries ?? [] } },
        purpose,
        ids: {
          pageId: settings.pageId,
          pixelId: settings.pixelId,
          conversionEvent: campaign.conversion_event,
        },
        startTime: campaign.starts_on && campaign.starts_on > today ? campaign.starts_on : null,
        endTime: campaign.ends_on,
      }),
    creative: (asset, imageHash) =>
      adCreativePayload({
        name: `${name} — ${asset.title?.trim() || asset.id}`,
        pageId: settings.pageId ?? "",
        imageHash,
        copy: copyOf(asset),
        destination: spec.template.destination,
      }),
    ad: (asset, adSetId, creativeId) =>
      adPayload({ name: `${name} — ${asset.title?.trim() || asset.id}`, adSetId, creativeId }),
  };
}

function attempt(problems: string[], prefix: string, build: () => unknown): void {
  try {
    build();
  } catch (error) {
    problems.push(prefix + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Every reason this build cannot finish, or an empty list.
 *
 * Collects rather than stopping at the first, so one run of the job tells a
 * person everything to fix instead of one thing per attempt.
 */
export function preflight(args: {
  campaign: CampaignRow;
  assets: readonly AssetRow[];
  settings: MetaSettings;
  currency: string;
  today: string;
}): { problems: string[]; inputs: BuildInputs | null } {
  const { campaign, assets, settings, currency, today } = args;
  const problems: string[] = [];

  const spec = resolveSpec(campaign);
  if ("problem" in spec) problems.push(spec.problem);

  const budget = Number(campaign.daily_budget);
  const hasBudget = campaign.daily_budget !== null && Number.isFinite(budget) && budget > 0;
  if (!hasBudget) problems.push("Set a daily budget for this campaign.");
  const hasCountries = (campaign.target_countries ?? []).length > 0;
  if (!hasCountries) problems.push("Choose at least one country for this campaign to run in.");
  if (!hasText(settings.pageId)) {
    problems.push("The Meta integration has no Facebook page. Add it in Account → Integrations.");
  }
  if (campaign.ends_on && campaign.ends_on < today) {
    problems.push(`This campaign ended on ${campaign.ends_on}. Meta will not build an ad set that has already finished.`);
  }

  const candidates = assets.filter(isAdCandidate);
  const buildable = (a: AssetRow) => a.media_type === "image" && a.content_format !== "carousel";
  for (const asset of candidates) {
    if (asset.media_type !== "image") {
      problems.push(`${assetLabel(asset)} is a ${asset.media_type}. Only images can be built as ads so far.`);
    } else if (asset.content_format === "carousel") {
      problems.push(`${assetLabel(asset)} is a carousel. Only single images can be built as ads so far.`);
    }
  }
  const ads = candidates.filter(buildable);
  if (ads.length === 0) {
    problems.push(
      "No approved image in this campaign has ad copy yet. Write the copy on the assets that should run as ads.",
    );
  }

  if ("problem" in spec) return { problems, inputs: null };

  for (const asset of ads) {
    const cta = templateProblem(spec.template, { cta: asset.ad_cta, mirrorOf: campaign.mirrors_template });
    if (cta) problems.push(`${assetLabel(asset)}: ${cta}`);
  }

  const inputs: BuildInputs = { spec, today, currency, settings, ads, purpose: purposeOf(ads) };
  const payloads = payloadsFor(campaign, inputs);

  // Run each builder once, with stand-ins for the ids Meta has not issued.
  // What they throw is what Meta would have been sent and refused.
  attempt(problems, "", payloads.campaign);
  // Only once the budget and countries are there, so a missing one is
  // reported once in plain words rather than again as a builder's error.
  if (hasBudget && hasCountries) attempt(problems, "", () => payloads.adSet(PENDING));
  // A missing page is already reported above; standing one in here lets the
  // copy's own problems through instead of repeating it once per asset.
  const probe = payloadsFor(campaign, { ...inputs, settings: { ...settings, pageId: settings.pageId || PENDING } });
  for (const asset of ads) {
    attempt(problems, `${assetLabel(asset)}: `, () => probe.creative(asset, PENDING));
  }

  return { problems: [...new Set(problems)], inputs: problems.length === 0 ? inputs : null };
}

/** What has already been built, read off the rows, in the shape build.ts plans from. */
export function builtState(campaign: CampaignRow, ads: readonly AssetRow[]): BuiltState {
  const assets: AssetState[] = ads.map((a) => ({
    assetId: a.id,
    imageHash: a.meta_image_hash,
    creativeId: a.meta_creative_id,
    adId: a.meta_ad_id,
  }));
  return { campaignId: campaign.meta_campaign_id, adSetId: campaign.meta_ad_set_id, assets };
}
