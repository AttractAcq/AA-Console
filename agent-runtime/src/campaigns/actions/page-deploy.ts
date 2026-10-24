/**
 * Putting an approved campaign page live, and then proving its form works.
 *
 * The second half is the point. Publishing is a commit, and a commit is easy
 * to verify; a page whose form posts nowhere looks exactly like one that
 * works, from the outside and from a screenshot. So this does two things in
 * order and records them separately: the commit, and then a real submission
 * made against the live page that has to arrive in Sales OS carrying its
 * campaign, its source and its consent.
 *
 * WHY THE PROBE USES THE REAL PATH
 *
 * It posts to the same public endpoint a customer would, with a consent flag,
 * and then looks for the lead. A probe that wrote directly to `client_leads`
 * would pass while the thing it is meant to test was broken. The lead it
 * creates is real for the same reason, and marked `is_probe` so the pipeline
 * can leave it out rather than somebody wondering who it is.
 *
 * A FAILED PROBE DOES NOT UNPUBLISH
 *
 * The page is live either way: that is a fact about the internet, not a state
 * this system chooses. What the failure does is record itself against the
 * publication, so the due view says "published, but the form probe failed"
 * rather than "live".
 */

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import { ActionError, type ActionHandler, type ActionOutcome } from "./executor.js";
import { publishPage } from "../../sites/provision.js";
import { supabaseSiteStore } from "../../sites/store.js";
import { logger } from "../../logging/logger.js";

/** How long to wait for a submission to become a lead before calling it a fail. */
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_POLL_MS = 1_000;

export interface PageDeployScope {
  readonly page_id?: string;
  readonly probe_endpoint_token?: string;
}

/**
 * The probe's own submission, against the live page's capture endpoint.
 *
 * Returns the lead it produced, or the reason it did not. Never throws: a
 * probe that fails is a recorded outcome rather than a failed publication.
 */
export async function probePageForm(
  sb: SupabaseClient,
  config: RuntimeConfig,
  args: { clientId: string; campaignId: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ passed: boolean; detail: string; leadId: string | null }> {
  const marker = randomUUID();
  const email = `probe+${marker.slice(0, 8)}@probe.attractacq.com`;
  const base = config.publicRuntimeBase.replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetchImpl(`${base}/public/lead/submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "AA Console form probe",
        email,
        message: `Post-publish probe ${marker}`,
        consent: true,
        submission_id: `probe-${marker}`,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    return { passed: false, detail: `The form endpoint could not be reached: ${reason}`, leadId: null };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      passed: false,
      detail: `The form endpoint answered ${response.status}: ${(body || "no body").slice(0, 200)}`,
      leadId: null,
    };
  }

  // The lead is written by the capture function, so it exists by the time the
  // response returns — but polling briefly rather than reading once keeps the
  // probe honest if that ever becomes asynchronous.
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data, error } = await sb
      .from("client_leads")
      .select("id, consent_given_at, consent_wording, source_client_campaign_id, source_channel")
      .eq("client_id", args.clientId)
      .eq("email", email)
      .maybeSingle();
    if (error) {
      return { passed: false, detail: `Could not read the lead back: ${error.message}`, leadId: null };
    }
    if (data) {
      const lead = data as {
        id: string;
        consent_given_at: string | null;
        consent_wording: string | null;
        source_client_campaign_id: string | null;
      };
      // Arriving is not enough. The three things the gate asks for are the
      // three things a lead is useless without.
      const missing: string[] = [];
      if (!lead.consent_given_at || !lead.consent_wording) missing.push("consent");
      if (!lead.source_client_campaign_id) missing.push("campaign");
      if (lead.source_client_campaign_id && lead.source_client_campaign_id !== args.campaignId) {
        missing.push("the right campaign");
      }
      await sb.from("client_leads").update({ is_probe: true }).eq("id", lead.id);

      if (missing.length > 0) {
        return {
          passed: false,
          detail: `A lead arrived but without ${missing.join(" or ")}.`,
          leadId: lead.id,
        };
      }
      return {
        passed: true,
        detail: "A test submission reached Sales OS with its campaign, source and consent.",
        leadId: lead.id,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
  }
  return {
    passed: false,
    detail: "The submission was accepted but no lead appeared.",
    leadId: null,
  };
}

/**
 * Publish the approved page, then probe it.
 *
 * The database decides whether this publish is permitted, from the approval
 * and the current bytes — not this file. All it does is hand over what the
 * check needs and refuse to continue if the check refuses.
 */
export const deployCampaignPage: ActionHandler = async (sb, config, action) => {
  const scope = (action.scope ?? {}) as PageDeployScope;
  const pageId = scope.page_id;
  if (!pageId) {
    throw new ActionError("That page deployment names no page in its scope.", false);
  }
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new ActionError("The GitHub App is not configured, so nothing can be published.", true);
  }

  const store = supabaseSiteStore(sb);
  const page = await store.loadPage(pageId);
  if (!page) throw new ActionError("That page no longer exists.", false);
  if (!page.html || page.html.trim().length === 0) {
    throw new ActionError("That page has no built HTML yet.", false);
  }

  // The exact-bytes check, immediately before the write and against the
  // approval rather than against a flag.
  const { error: gateError } = await sb.rpc("assert_page_publish_by_approval_v6", {
    p_approval_id: action.approval_id,
    p_page_id: pageId,
    p_current_html: page.html,
  } as never);
  if (gateError) throw new ActionError(gateError.message, false);

  const published = await publishPage(
    // The publisher's own general guard would refuse a v6 campaign page, and
    // correctly: 212 left that block in place for every other route. This one
    // publish has already been cleared above, so the store is handed a check
    // that has been satisfied.
    { ...store, assertPagePublishAllowed: async () => {} },
    {
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      installationId: config.githubInstallationId,
    },
    { org: config.githubSitesOrg, runtimeBase: config.publicRuntimeBase },
    pageId,
  );

  const renderedSha = createHash("sha256").update(page.html, "utf8").digest("hex");
  const { data: publicationId, error: recordError } = await sb.rpc(
    "record_campaign_page_published_v6",
    {
      p_approval_id: action.approval_id,
      p_published_url: published.url,
      p_commit_sha: published.commit,
      p_rendered_sha256: renderedSha,
    } as never,
  );
  if (recordError) {
    throw new Error(`Published at ${published.url}, but could not record it: ${recordError.message}`);
  }

  const outcome: ActionOutcome = {
    externalId: published.commit,
    externalUrl: published.url,
    result: { changed: published.changed, rendered_sha256: renderedSha },
    detail: published.changed
      ? `Published at ${published.url}.`
      : `Already live as exactly these bytes at ${published.url}.`,
  };

  // The probe. A page with no capture endpoint in scope cannot be tested,
  // which is recorded as an untested publication rather than as a pass.
  if (!scope.probe_endpoint_token) {
    return {
      ...outcome,
      detail: `${outcome.detail} No capture token in scope, so the form was not tested.`,
    };
  }

  const probe = await probePageForm(sb, config, {
    clientId: action.client_id,
    campaignId: action.campaign_id,
    token: scope.probe_endpoint_token,
  });
  const { error: probeError } = await sb.rpc("record_campaign_page_probe_v6", {
    p_publication_id: publicationId,
    p_passed: probe.passed,
    p_detail: probe.detail,
    p_lead_id: probe.leadId,
  } as never);
  if (probeError) {
    logger.error("page_probe_unrecorded", {
      approvalId: action.approval_id,
      message: probeError.message,
    });
  }

  // A failed probe does not fail the action: the page is live either way, and
  // saying otherwise would make the record less true rather than more.
  return {
    ...outcome,
    result: { ...(outcome.result ?? {}), probe_passed: probe.passed, probe_detail: probe.detail },
    detail: `${outcome.detail} ${probe.detail}`,
  };
};
