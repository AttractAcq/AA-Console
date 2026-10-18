// AA recruitment ads use their own campaign records, but the same paused Meta
// payloads, preflight and resumable build steps as client paid distribution.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { readAccountCurrency } from "../../meta/ads.js";
import { buildPlan, buildProblem } from "../../meta/build.js";
import type { CampaignTemplate } from "../../campaigns/templates.js";
import { buildFailure, loadIntegration, metaWriter } from "../meta_build/index.js";
import { builtState, payloadsFor, preflight, type AssetRow, type CampaignRow, type ResolvedSpec } from "../meta_build/plan.js";
import { executeBuild, progressFrom, UnrecordedError, type BuildStore, type MetaWriter } from "../meta_build/execute.js";

const template: CampaignTemplate = {
  code: "AA_RECRUITMENT", name: "AA recruitment", fn: "build", entry: "S0", exit: "S3",
  objective: "OUTCOME_LEADS", optimisation: "OFFSITE_CONVERSIONS",
  ctas: ["APPLY_NOW", "LEARN_MORE", "SIGN_UP", "CONTACT_US"], destination: "page",
  kpi: "Completed applications", purpose: "Attract qualified candidates for AA roles.",
  guardrail: "Only approved hiring ads with an application page.", prerequisite: null, mirrors: false,
};
export const RECRUITMENT_SPEC: ResolvedSpec = { template, objective: "OUTCOME_LEADS", optimisation: "OFFSITE_CONVERSIONS" };

type RecruitmentCampaign = {
  id: string; client_id: string; name: string; daily_budget: number;
  target_countries: string[]; conversion_event: string;
  meta_campaign_id: string | null; meta_ad_set_id: string | null;
};
type Selection = {
  asset_id: string; meta_image_hash: string | null;
  meta_creative_id: string | null; meta_ad_id: string | null;
};
type Image = {
  id: string; brief_id: string | null; title: string | null; media_type: string;
  content_format: string | null; storage_path: string | null;
  review_status: string; purpose: string | null;
};
type Brief = {
  id: string; purpose: string; hook: string | null; script: string | null;
  compensation_text: string | null; apply_url: string | null; call_to_action: string | null;
};

function fail(message: string, retryable = false): JobResult {
  return { ok: false, retryable, failureMessage: message };
}

async function selectedAds(sb: SupabaseClient, campaign: RecruitmentCampaign): Promise<AssetRow[]> {
  const { data: selected, error: selectionError } = await sb
    .from("recruitment_meta_campaign_ads")
    .select("asset_id,meta_image_hash,meta_creative_id,meta_ad_id")
    .eq("campaign_id", campaign.id).order("asset_id");
  if (selectionError) throw new Error(`Could not read selected recruitment ads: ${selectionError.message}`);
  const selections = (selected ?? []) as Selection[];
  if (selections.length === 0) return [];
  const { data: images, error: imageError } = await sb.from("client_media_assets")
    .select("id,brief_id,title,media_type,content_format,storage_path,review_status,purpose")
    .eq("client_id", campaign.client_id).in("id", selections.map((s) => s.asset_id));
  if (imageError) throw new Error(`Could not read recruitment images: ${imageError.message}`);
  const assetRows = (images ?? []) as Image[];
  const briefIds = assetRows.flatMap((a) => a.brief_id ? [a.brief_id] : []);
  const { data: briefs, error: briefError } = briefIds.length
    ? await sb.from("client_briefs")
      .select("id,purpose,hook,script,compensation_text,apply_url,call_to_action")
      .eq("client_id", campaign.client_id).in("id", briefIds)
    : { data: [], error: null };
  if (briefError) throw new Error(`Could not read recruitment copy: ${briefError.message}`);
  const byImage = new Map(assetRows.map((a) => [a.id, a]));
  const byBrief = new Map(((briefs ?? []) as Brief[]).map((b) => [b.id, b]));
  return selections.map((selection) => {
    const image = byImage.get(selection.asset_id);
    const brief = image?.brief_id ? byBrief.get(image.brief_id) : null;
    if (!image || !brief || image.purpose !== "recruitment" || brief.purpose !== "recruitment") {
      throw new Error("A selected ad or its recruitment brief is missing. Nothing was sent to Meta.");
    }
    return {
      id: image.id, title: image.title, media_type: image.media_type,
      content_format: image.content_format, storage_path: image.storage_path,
      review_status: image.review_status, purpose: image.purpose,
      ad_primary_text: brief.script, ad_headline: brief.hook,
      ad_description: brief.compensation_text, ad_link_url: brief.apply_url,
      ad_cta: brief.call_to_action, meta_image_hash: selection.meta_image_hash,
      meta_creative_id: selection.meta_creative_id, meta_ad_id: selection.meta_ad_id,
    };
  });
}

function storeFor(sb: SupabaseClient, campaignId: string): BuildStore {
  const save = async (table: string, filters: Record<string, string>, values: Record<string, string>) => {
    let query = sb.from(table).update(values);
    for (const [column, id] of Object.entries(filters)) query = query.eq(column, id);
    const { error } = await query;
    if (error) throw new UnrecordedError(`Meta created an object but its id could not be recorded: ${error.message}`);
  };
  const saveAsset = (assetId: string, values: Record<string, string>) =>
    save("recruitment_meta_campaign_ads", { campaign_id: campaignId, asset_id: assetId }, values);
  return {
    saveCampaignId: (id) => save("recruitment_meta_campaigns", { id: campaignId }, { meta_campaign_id: id }),
    saveAdSetId: (id) => save("recruitment_meta_campaigns", { id: campaignId }, { meta_ad_set_id: id }),
    saveImageHash: (assetId, hash) => saveAsset(assetId, { meta_image_hash: hash }),
    saveCreativeId: (assetId, id) => saveAsset(assetId, { meta_creative_id: id }),
    saveAdId: (assetId, id) => saveAsset(assetId, { meta_ad_id: id }),
    loadImage: async (asset) => {
      const path = asset.storage_path ?? "";
      const { data, error } = await sb.storage.from("client-media").download(path);
      if (error || !data) throw new Error(`Could not read recruitment image ${asset.title ?? asset.id}: ${error?.message ?? "no file"}`);
      return { bytes: new Uint8Array(await data.arrayBuffer()), filename: path.split("/").pop() || path };
    },
  };
}

export async function runRecruitmentMetaBuildJob(
  sb: SupabaseClient, _config: RuntimeConfig, _agent: AgentRow, job: AgentJobRow,
  _deadlineAt?: number,
  deps: { writer?: (account: { accessToken: string; accountId: string }) => MetaWriter;
    currency?: (account: { accessToken: string; accountId: string }) => Promise<string> } = {},
): Promise<JobResult> {
  if (!job.client_id || job.input_table !== "recruitment_meta_campaigns" || !job.input_id) {
    return fail("A recruitment Meta build needs a selected AA recruitment campaign.");
  }
  const { data: house, error: houseError } = await sb.rpc("aa_house_client_id");
  if (houseError) throw new Error(`Could not find AA's house account: ${houseError.message}`);
  if (job.client_id !== house) return fail("Recruitment ads may only use AA's house account.");
  const { data, error } = await sb.from("recruitment_meta_campaigns").select("*")
    .eq("id", job.input_id).eq("client_id", job.client_id).maybeSingle();
  if (error) throw new Error(`Could not read recruitment campaign: ${error.message}`);
  if (!data) return fail("That recruitment campaign no longer exists.");
  const campaign = data as RecruitmentCampaign;
  const { data: concurrent, error: concurrentError } = await sb.from("agent_jobs").select("id")
    .eq("agent_key", "recruitment_meta_build").eq("input_id", campaign.id)
    .in("status", ["claimed", "running"]).neq("id", job.id).limit(1);
  if (concurrentError) throw new Error(`Could not check recruitment builds: ${concurrentError.message}`);
  if ((concurrent ?? []).length) return fail("Another build of this recruitment campaign is running.", true);

  const integration = await loadIntegration(sb, job.client_id);
  if ("problem" in integration) return fail(integration.problem!);
  const assets = await selectedAds(sb, campaign);
  const row: CampaignRow = {
    ...campaign, template: null, mirrors_template: null, optimisation_event: null,
    starts_on: null, ends_on: null,
  };
  const currency = await (deps.currency ?? readAccountCurrency)(integration.account);
  const checked = preflight({
    campaign: row, assets, settings: integration.settings, currency,
    today: new Date().toISOString().slice(0, 10), spec: RECRUITMENT_SPEC,
  });
  if (!checked.inputs) return fail(`Nothing was sent to Meta. Fix these first:\n- ${checked.problems.join("\n- ")}`);
  const inputs = checked.inputs;
  const state = builtState(row, inputs.ads);
  const issue = buildProblem(state);
  if (issue) return fail(issue);
  const steps = buildPlan(state);
  await appendEvent(sb, job.id,
    `Building ${inputs.ads.length} recruitment ad(s) in ${integration.account.accountId}; all Meta objects stay paused.`);
  try {
    await executeBuild({
      steps, ads: inputs.ads, payloads: payloadsFor(row, inputs),
      progress: progressFrom(row, inputs.ads),
      meta: (deps.writer ?? metaWriter)(integration.account),
      store: storeFor(sb, campaign.id), log: (line) => appendEvent(sb, job.id, line),
    });
  } catch (error) {
    return buildFailure(error);
  }
  const { error: stampError } = await sb.from("recruitment_meta_campaigns")
    .update({ meta_built_at: new Date().toISOString() }).eq("id", campaign.id);
  if (stampError) throw new UnrecordedError(`Built in Meta but could not mark recruitment campaign complete: ${stampError.message}`);
  await appendEvent(sb, job.id, "Recruitment campaign and selected ads are ready in Ads Manager, paused.");
  return { ok: true, retryable: false };
}
