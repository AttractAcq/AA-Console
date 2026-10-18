/**
 * The build a person does by hand, written into the job log.
 *
 * meta_build cannot run without a Meta token. When there is no usable one —
 * a locked-out login, an expired system user, an account not yet shared with
 * us — the campaign is still fully specified here, and somebody with Ads
 * Manager access can create the structure themselves. This agent is what hands
 * them the numbers, taken from the same payload builders meta_build sends, so
 * a hand build and an automated one cannot disagree.
 *
 * Read-only in two senses that both matter:
 *
 *   - It never calls Meta. There is no token read, no transport imported, and
 *     nothing here could create an object in an ad account if it tried.
 *   - It writes nothing but its own job events. In particular it does not
 *     touch meta_campaign_id: the ids come back from the person who built it,
 *     through the campaign's own form, because only they know what Meta issued.
 *
 * It deliberately does not require a usable integration. The status is often
 * exactly what is broken when this is wanted, and a sheet refused because the
 * credential is dead would be refused precisely when it is needed. All it
 * needs off the integration is the Facebook page and the pixel, neither of
 * which is a secret.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { adAccountFor } from "../../meta/account.js";
import { CAMPAIGN_COLUMNS, loadAssets } from "../meta_build/index.js";
import type { CampaignRow, MetaSettings } from "../meta_build/plan.js";
import { buildSheet, renderSheet, sheetSections, type ManualSheet } from "../meta_build/sheet.js";

/**
 * Longest description written in one event.
 *
 * appendEvent truncates at 2000, silently. A section over the limit is split
 * across events rather than cut, because the half that would go missing is as
 * likely to be the link or the budget as anything else.
 */
const MAX_EVENT = 1800;

function fail(message: string, retryable = false): JobResult {
  return { ok: false, retryable, failureMessage: message };
}

/**
 * The page and pixel the sheet needs, with no credential read.
 *
 * The ad account id is reported when it is recorded and shaped like one, and
 * left out otherwise: naming the account someone should build in is a
 * convenience, and a wrong one is worse than none.
 */
export async function loadSheetSettings(
  sb: SupabaseClient,
  clientId: string,
): Promise<{ settings: MetaSettings; accountId: string | null } | { problem: string }> {
  const { data: row, error } = await sb
    .from("client_integrations")
    .select("status, ad_account_id, credential_label, meta_page_id, meta_pixel_id")
    .eq("client_id", clientId)
    .eq("provider", "meta")
    .maybeSingle();
  if (error) throw new Error(`Could not read the Meta integration: ${error.message}`);
  if (!row) {
    return { problem: "This client has no Meta integration, so there is no page to run the ads from." };
  }

  const account = adAccountFor(row);
  return {
    settings: {
      pageId: (row.meta_page_id as string | null) ?? null,
      pixelId: (row.meta_pixel_id as string | null) ?? null,
    },
    accountId: "id" in account ? account.id : null,
  };
}

/**
 * The sheet's sections as event descriptions, numbered and within the limit.
 *
 * Numbered because the console lists events newest first, and a sheet read
 * bottom-up needs to say where it starts. The count is of sections rather than
 * events, so a section that had to be split still reads as one part.
 */
export function sheetEvents(sheet: ManualSheet): string[] {
  const sections = sheetSections(sheet);
  const out: string[] = [];

  for (const [index, section] of sections.entries()) {
    const label = `${index + 1}/${sections.length} ${section.title}`;
    let current = label;
    for (const bodyLine of section.body) {
      // One line longer than a whole event can only be split mid-line, and a
      // link or a paragraph of body copy is exactly the case. It goes out on
      // its own, chunked, rather than being dropped.
      if (bodyLine.length + 1 > MAX_EVENT) {
        if (current) out.push(current);
        current = "";
        for (let at = 0; at < bodyLine.length; at += MAX_EVENT) {
          out.push(bodyLine.slice(at, at + MAX_EVENT));
        }
        continue;
      }
      if (current.length + bodyLine.length + 1 > MAX_EVENT) {
        out.push(current);
        current = `${label} (continued)`;
      }
      current = current ? `${current}\n${bodyLine}` : bodyLine;
    }
    if (current) out.push(current);
  }

  return out;
}

/**
 * Writes one campaign's manual build sheet, or says why there is none.
 *
 * The refusals are preflight's, through buildSheet: a campaign the runtime
 * could not build is one a person cannot build either, and a sheet that hid a
 * missing page would send them into Ads Manager to find that out themselves.
 */
export async function runMetaBuildSheetJob(
  sb: SupabaseClient,
  _config: RuntimeConfig,
  _agent: AgentRow,
  job: AgentJobRow,
  // No model and no network, so nothing to cut short.
  _deadlineAt?: number,
): Promise<JobResult> {
  if (!job.client_id) return fail("A build sheet needs a client.");
  if (job.input_table !== "client_campaigns" || !job.input_id) {
    return fail("A build sheet needs the campaign to write it for. Start it from the campaign.");
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

  const integration = await loadSheetSettings(sb, job.client_id);
  if ("problem" in integration) return fail(integration.problem);

  const assets = await loadAssets(sb, job.client_id, row.id);
  const today = new Date().toISOString().slice(0, 10);

  // No currency: there is no token to read the account's own with, which is
  // the whole reason this agent exists. buildSheet says so in its caveats.
  const result = buildSheet({ campaign: row, assets, settings: integration.settings, today });
  if (!result.sheet) {
    return fail(`No sheet was written. Fix these first:\n- ${result.problems.join("\n- ")}`);
  }

  const where = integration.accountId ? ` in ${integration.accountId}` : "";
  await appendEvent(
    sb,
    job.id,
    `Manual build sheet for "${row.name}"${where}. Create everything PAUSED; launching stays a person in Ads Manager.`,
  );

  for (const description of sheetEvents(result.sheet)) {
    await appendEvent(sb, job.id, description);
  }

  // The whole sheet on one event too. Nothing shows payloads today, but it is
  // the only copy that survives as one block for anything reading the job
  // later, and it costs one row.
  await appendEvent(
    sb,
    job.id,
    `Sheet written: ${result.sheet.ads.length} ad(s) to create by hand.`,
    "info",
    { sheet: renderSheet(result.sheet) },
  );

  return { ok: true, retryable: false };
}
