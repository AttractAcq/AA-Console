// Meta build runner.
//
// Turns one campaign's approved, copy-carrying image assets into a paused
// Meta campaign, ad set and ads. No model: every decision here has one right
// answer, and the ones that can cost money are made by the payload builders
// in src/meta, which have no way to produce a live object.
//
// Order of work, and why:
//   1. Read everything, and refuse anything that cannot finish (plan.ts)
//      before the first call to Meta, so a refusal never leaves a
//      half-built structure in somebody's ad account.
//   2. Ask Meta which currency the account bills in, because the budget is
//      sent in its minor units.
//   3. Build only what is not already recorded (build.ts), writing each id
//      back as it arrives (execute.ts). Running this twice is safe; running
//      it twice at once is refused by request_meta_build and again below.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { adAccountFor } from "../../meta/account.js";
import {
  MetaWriteError,
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  readAccountCurrency,
  type AdAccount,
} from "../../meta/ads.js";
import { uploadAdImage } from "../../meta/creative.js";
import { buildPlan, buildProblem } from "../../meta/build.js";
import { builtState, isAdCandidate, payloadsFor, preflight, type AssetRow, type CampaignRow } from "./plan.js";
import { UnrecordedError, executeBuild, progressFrom, type BuildStore, type MetaWriter } from "./execute.js";

const BUCKET = "client-media";

const CAMPAIGN_COLUMNS =
  "id, client_id, name, template, mirrors_template, optimisation_event, conversion_event, daily_budget, target_countries, starts_on, ends_on, meta_campaign_id, meta_ad_set_id";

const ASSET_COLUMNS =
  "id, title, media_type, content_format, storage_path, review_status, purpose, ad_primary_text, ad_headline, ad_description, ad_link_url, ad_cta, meta_image_hash, meta_creative_id, meta_ad_id";

/** The states an integration can be used from. An allow list, as in migration 124. */
const USABLE = ["connected", "active"];

function fail(message: string, retryable = false): JobResult {
  return { ok: false, retryable, failureMessage: message };
}

/** The campaign's content assets, by the same links campaign_readiness counts. */
async function loadAssets(sb: SupabaseClient, clientId: string, campaignId: string): Promise<AssetRow[]> {
  const { data: links, error } = await sb
    .from("campaign_artifacts")
    .select("brief_id, asset_id")
    .eq("campaign_id", campaignId)
    .eq("client_id", clientId)
    .eq("kind", "content");
  if (error) throw new Error(`Could not read the campaign's content: ${error.message}`);

  const briefIds = (links ?? []).flatMap((l) => (l.brief_id ? [l.brief_id as string] : []));
  const assetIds = (links ?? []).flatMap((l) => (l.asset_id ? [l.asset_id as string] : []));
  const [byBrief, direct] = await Promise.all([
    briefIds.length
      ? sb.from("client_media_assets").select(ASSET_COLUMNS).eq("client_id", clientId).in("brief_id", briefIds)
      : Promise.resolve({ data: [], error: null }),
    assetIds.length
      ? sb.from("client_media_assets").select(ASSET_COLUMNS).eq("client_id", clientId).in("id", assetIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byBrief.error) throw new Error(`Could not read the campaign's assets: ${byBrief.error.message}`);
  if (direct.error) throw new Error(`Could not read the campaign's assets: ${direct.error.message}`);

  const all = [...(byBrief.data ?? []), ...(direct.data ?? [])] as AssetRow[];
  // Oldest first would be nicer, but stable is what matters: the same
  // campaign builds its ads in the same order every run.
  return [...new Map(all.map((a) => [a.id, a])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadIntegration(sb: SupabaseClient, clientId: string) {
  const { data: row, error } = await sb
    .from("client_integrations")
    .select("status, ad_account_id, credential_label, meta_page_id, meta_pixel_id")
    .eq("client_id", clientId)
    .eq("provider", "meta")
    .maybeSingle();
  if (error) throw new Error(`Could not read the Meta integration: ${error.message}`);
  if (!row) return { problem: "This client has no Meta integration. Connect one in Account → Integrations." };
  if (!USABLE.includes(String(row.status))) {
    return { problem: `The Meta integration is in "${row.status}". Reconnect it in Account → Integrations.` };
  }

  const account = adAccountFor(row);
  if ("problem" in account) return { problem: account.problem };

  const { data: token, error: secretError } = await sb.rpc("integration_secret", {
    p_client_id: clientId,
    p_provider: "meta",
  });
  if (secretError) throw new Error(`Could not read the Meta credential: ${secretError.message}`);
  if (!token) return { problem: "The Meta integration has no credential stored." };

  return {
    account: { accessToken: String(token), accountId: account.id } satisfies AdAccount,
    settings: {
      pageId: (row.meta_page_id as string | null) ?? null,
      pixelId: (row.meta_pixel_id as string | null) ?? null,
    },
  };
}

/** Another build of the same campaign that is still going. */
async function concurrentBuild(sb: SupabaseClient, job: AgentJobRow): Promise<boolean> {
  const { data, error } = await sb
    .from("agent_jobs")
    .select("id")
    .eq("agent_key", "meta_build")
    .eq("input_table", "client_campaigns")
    .eq("input_id", job.input_id)
    .in("status", ["claimed", "running"])
    .neq("id", job.id)
    .limit(1);
  if (error) throw new Error(`Could not check for another build: ${error.message}`);
  return (data ?? []).length > 0;
}

function filenameOf(path: string): string {
  return path.split("/").pop() || path;
}

export function metaWriter(account: AdAccount): MetaWriter {
  return {
    createCampaign: (p) => createCampaign(account, p),
    createAdSet: (p) => createAdSet(account, p),
    uploadImage: (image) => uploadAdImage(account, image),
    createCreative: (p) => createAdCreative(account, p),
    createAd: (p) => createAd(account, p),
  };
}

function buildStore(sb: SupabaseClient, campaignId: string): BuildStore {
  const write = async (table: string, id: string, values: Record<string, unknown>) => {
    const { error } = await sb.from(table).update(values).eq("id", id);
    // The id already exists at Meta. Failing loudly here is what stops the
    // next run from creating it again without anyone knowing why.
    if (error) {
      throw new UnrecordedError(
        `Meta created an object but its id could not be recorded (${JSON.stringify(values)}): ${error.message}. ` +
          "Record it by hand before building again.",
      );
    }
  };
  return {
    saveCampaignId: (id) => write("client_campaigns", campaignId, { meta_campaign_id: id }),
    saveAdSetId: (id) => write("client_campaigns", campaignId, { meta_ad_set_id: id }),
    saveImageHash: (assetId, hash) => write("client_media_assets", assetId, { meta_image_hash: hash }),
    saveCreativeId: (assetId, id) => write("client_media_assets", assetId, { meta_creative_id: id }),
    saveAdId: (assetId, id) => write("client_media_assets", assetId, { meta_ad_id: id }),
    loadImage: async (asset) => {
      const path = asset.storage_path ?? "";
      const { data, error } = await sb.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error(`Could not read the image for ${asset.title ?? asset.id}: ${error?.message ?? "no file"}`);
      return { bytes: new Uint8Array(await data.arrayBuffer()), filename: filenameOf(path) };
    },
  };
}

const CHECK_ADS_MANAGER =
  " Check Ads Manager for anything this build made before pressing Build again.";

/**
 * Whether a failure part-way through a build may be retried automatically.
 *
 * Everything created before the failure is recorded, so a retry resumes from
 * the failing step. The exceptions are the two cases where Meta may have
 * made something that was not recorded: an id that could not be saved, and a
 * request that never got an answer. Retrying either could build a second
 * campaign, so both stop and hand the decision to a person. An answer from
 * Meta — a rate limit, a refusal — is safe to act on as classified.
 */
export function buildFailure(err: unknown): JobResult {
  if (err instanceof UnrecordedError) return fail(err.message);
  if (err instanceof MetaWriteError) {
    const unanswered = err.status === null && err.retryable;
    return unanswered ? fail(err.message + CHECK_ADS_MANAGER) : fail(err.message, err.retryable);
  }
  // Reading an image or the database before anything was sent is safe to
  // retry, but this cannot tell which step threw, so it is not retried.
  const message = err instanceof Error ? err.message : String(err);
  return fail(message + CHECK_ADS_MANAGER);
}

export async function runMetaBuildJob(
  sb: SupabaseClient,
  _config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  // No model, so nothing to cut short; bounded by the lease like metrics_ingest.
  _deadlineAt?: number,
  deps: { writer?: (account: AdAccount) => MetaWriter; currency?: (account: AdAccount) => Promise<string> } = {},
): Promise<JobResult> {
  if (!job.client_id) return fail("A Meta build needs a client.");
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return fail("A Meta build needs the campaign to build. Start it from the campaign.");
  }

  const { data: campaign, error } = await sb
    .from("client_campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("id", job.input_id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the campaign: ${error.message}`);
  if (!campaign) return fail("That campaign no longer exists.");
  if (campaign.client_id !== job.client_id) return fail("That campaign belongs to a different client.");
  const row = campaign as unknown as CampaignRow;

  if (await concurrentBuild(sb, job)) {
    return fail("Another build of this campaign is running. This one will try again after it.", true);
  }

  const integration = await loadIntegration(sb, job.client_id);
  if ("problem" in integration) return fail(integration.problem!);

  const assets = await loadAssets(sb, job.client_id, row.id);
  await appendEvent(
    sb,
    job.id,
    `Building "${row.name}" in ${integration.account.accountId}: ${assets.filter(isAdCandidate).length} asset(s) with ad copy.`,
  );

  let currency: string;
  try {
    currency = await (deps.currency ?? readAccountCurrency)(integration.account);
  } catch (err) {
    if (err instanceof MetaWriteError) return fail(err.message, err.retryable);
    throw err;
  }

  const today = new Date().toISOString().slice(0, 10);
  const checked = preflight({ campaign: row, assets, settings: integration.settings, currency, today });
  if (!checked.inputs) {
    return fail(`Nothing was sent to Meta. Fix these first:\n- ${checked.problems.join("\n- ")}`);
  }
  const { inputs } = checked;

  const state = builtState(row, inputs.ads);
  const problem = buildProblem(state);
  if (problem) return fail(problem);

  const steps = buildPlan(state);
  if (steps.length > 0) {
    await appendEvent(sb, job.id, `${steps.length} step(s) to build; everything is created paused.`);
    try {
      await executeBuild({
        steps,
        ads: inputs.ads,
        payloads: payloadsFor(row, inputs),
        progress: progressFrom(row, inputs.ads),
        meta: (deps.writer ?? metaWriter)(integration.account),
        store: buildStore(sb, row.id),
        log: (line) => appendEvent(sb, job.id, line),
      });
    } catch (err) {
      return buildFailure(err);
    }
  } else {
    await appendEvent(sb, job.id, "Everything is already built. Nothing was sent to Meta.");
  }

  // executeBuild either ran every step or threw, so reaching here means the
  // whole structure exists at Meta and is recorded.
  const { error: stampError } = await sb
    .from("client_campaigns")
    .update({ meta_built_at: new Date().toISOString() })
    .eq("id", row.id);
  if (stampError) throw new Error(`Built, but could not record when: ${stampError.message}`);

  await appendEvent(sb, job.id, "Built and paused. Review it in Ads Manager and launch from there.");
  return { ok: true, retryable: false };
}
