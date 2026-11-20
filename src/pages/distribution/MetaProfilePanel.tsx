import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { PROFILE_FIELD_PATCH_HOLD } from "../../../agent-runtime/src/profiles/prewrite-gate.js";
import { MetaAdsReadPanel } from "./MetaAdsReadPanel";

// The view's historical health_detail and derived blocker can include a raw
// provider OAuth error. Keep both out of the browser response until a SQL
// migration can scrub the stored data and fix the view itself.
type Identity = Pick<
  Database["public"]["Views"]["meta_identity_health"]["Row"],
  "client_id" | "provider" | "account_ref" | "status" | "token_expires_at" | "days_left" | "posts_waiting"
>;
type Presence = Database["public"]["Views"]["meta_profile_presence"]["Row"];
// A historical failure reason may contain raw provider diagnostics. Fetch only
// the proposal fields used by this screen until the database is scrubbed.
type ProfileChange = Pick<
  Database["public"]["Tables"]["meta_profile_changes"]["Row"],
  "id" | "platform" | "field" | "current_value" | "proposed_value" | "offer_version_id" | "status" | "approved_request_id" | "created_at"
>;
type ProfileDecision = Pick<Database["public"]["Views"]["approval_inbox_v6"]["Row"],
  "id" | "status">;
type ProfileOutcome = Pick<Database["public"]["Views"]["meta_profile_execution_overview_v6"]["Row"],
  "attempt_id" | "change_id" | "status" | "provider_ref" | "reconciliation_result" | "reconciled_at">;
type ProfileJob = Pick<Database["public"]["Tables"]["agent_jobs"]["Row"],
  "id" | "agent_key" | "input_id" | "status">;

function presenceReadbackLabel(post: Presence): string {
  switch (post.provider_readback_state) {
    case "uncertain": return "Provider outcome uncertain; inspect before retry";
    case "verified": return "Verified on the exact provider account";
    case "mismatch": return "Provider post or account mismatch; inspect";
    case "unavailable": return "Provider read unavailable; presence unknown";
    case "partial": return "Story frame acknowledgement incomplete";
    case "no_provider_id": return "No provider ID; presence unknown";
    case "missing": return "Provider read missing; presence unknown";
    default: return "No publication recorded";
  }
}

type Tab = "identities" | "profile" | "presence";

function recordedIdentityAlert(identity: Identity, now = Date.now()): string | null {
  const status = identity.status ?? "";
  if (["error", "expired", "revoked"].includes(status)) {
    return "Recorded integration status blocks this account. Reconnect or review its credential.";
  }
  if (!["connected", "active", "expiring"].includes(status)) {
    return "Integration status needs review before this account is used.";
  }
  const expiry = identity.token_expires_at ? Date.parse(identity.token_expires_at) : Number.NaN;
  if (Number.isFinite(expiry) && expiry <= now) {
    return "The recorded token expiry has passed. Reconnect before use.";
  }
  if (status === "expiring" && !Number.isFinite(expiry)) {
    return "The integration is marked expiring without a known expiry. Review its credential.";
  }
  if (Number.isFinite(expiry) && expiry < now + 7 * 24 * 60 * 60 * 1000) {
    return "The recorded token expiry is near. Reconnect before it expires.";
  }
  return null;
}

/**
 * Meta Profile v2 — Identities, Profile and Presence.
 *
 * v1 reuses the organic post board and the organic metrics tab, which means
 * it shows neither local integration blockers nor the profile a visitor sees
 * after an ad.
 *
 * Identities shows recorded status, expiry and queued work. Those fields can
 * identify blockers, but cannot prove current account ownership, scope or
 * publishing rights. A blocked credential comes with the count of work
 * waiting on it, rather than appearing as an empty post board.
 */
export function MetaProfilePanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  return <MetaProfilePanelForClient key={clientId ?? "no-client"} clientId={clientId} tab={tab} />;
}

function MetaProfilePanelForClient({ clientId, tab }: {
  clientId: string | undefined; tab: Tab;
}) {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [changes, setChanges] = useState<ProfileChange[]>([]);
  const [profileDecisions, setProfileDecisions] = useState<ReadonlyMap<string, ProfileDecision>>(new Map());
  const [profileOutcomes, setProfileOutcomes] = useState<ProfileOutcome[]>([]);
  const [profileJobs, setProfileJobs] = useState<ProfileJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [health, posts, proposed, profileCards, outcomes, jobs] = await Promise.all([
        supabase.from("meta_identity_health")
          .select("client_id,provider,account_ref,status,token_expires_at,days_left,posts_waiting")
          .eq("client_id", clientId),
        supabase
          .from("meta_profile_presence")
          .select("*")
          .eq("client_id", clientId)
          .order("published_at", { ascending: false })
          .limit(100),
        supabase
          .from("meta_profile_changes")
          .select("id,platform,field,current_value,proposed_value,offer_version_id,status,approved_request_id,created_at")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase.from("approval_inbox_v6").select("id,status")
          .eq("client_id", clientId).eq("source_kind", "meta_profile_change"),
        supabase.from("meta_profile_execution_overview_v6")
          .select("attempt_id,change_id,status,provider_ref,reconciliation_result,reconciled_at")
          .eq("client_id", clientId),
        supabase.from("agent_jobs").select("id,agent_key,input_id,status")
          .eq("client_id", clientId)
          .in("agent_key", ["meta_profile_field_writer", "meta_profile_field_reconciler"]),
      ]);
      for (const result of [health, posts, proposed, profileCards, outcomes, jobs]) {
        if (result.error) throw new Error("Profile read failed.");
      }
      setIdentities(health.data ?? []);
      setPresence(posts.data ?? []);
      setChanges(proposed.data ?? []);
      setProfileDecisions(new Map((profileCards.data ?? [])
        .filter((row): row is ProfileDecision & { id: string } => Boolean(row.id))
        .map((row) => [row.id, row])));
      setProfileOutcomes(outcomes.data ?? []);
      setProfileJobs(jobs.data ?? []);
      setError(null);
    } catch {
      setError("Could not load the profiles.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function requestReview(changeId: string) {
    setReviewBusy(changeId);
    setError(null);
    try {
      const result = await supabase.rpc("request_meta_profile_review_v6", { p_change_id: changeId });
      if (result.error) throw result.error;
      await refresh();
    } catch {
      setError("Could not open the exact Meta profile proposal for Inbox review.");
    } finally {
      setReviewBusy(null);
    }
  }

  async function requestWrite(changeId: string) {
    setReviewBusy(changeId);
    setError(null);
    try {
      const result = await supabase.rpc("request_meta_profile_write_v6", { p_change_id: changeId });
      if (result.error) throw result.error;
      await refresh();
    } catch {
      setError("Could not queue the exact Facebook Page field proposal.");
    } finally {
      setReviewBusy(null);
    }
  }

  async function requestReconciliation(attemptId: string) {
    setReviewBusy(attemptId);
    setError(null);
    try {
      const result = await supabase.rpc("request_meta_profile_reconciliation_v6", {
        p_attempt_id: attemptId,
      });
      if (result.error) throw result.error;
      await refresh();
    } catch {
      setError("Could not queue a read-only check of the uncertain Page field.");
    } finally {
      setReviewBusy(null);
    }
  }

  const broken = identities.filter((identity) => recordedIdentityAlert(identity)).length;

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "identities" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium">
              {identities.length === 0
                ? "No Meta identity recorded"
                : broken > 0
                  ? `${broken} of ${identities.length} identities need attention`
                  : `No status or expiry alerts for ${identities.length} Meta identit${identities.length === 1 ? "y" : "ies"}; credential and provider access unverified`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This shows recorded status, expiry and queued posts. It does not verify the current
              credential, account, token permissions or publishing rights.
            </p>
          </div>

          {identities.length === 0 && !loading ? (
            <EmptyState label="Connect Instagram or Facebook on the Integrations page" />
          ) : (
            <DataTable
              columns={["Account", "Status", "Token", "Waiting on it", "What is stopping it"]}
              emptyLabel={loading ? "Loading…" : "No identities"}
              rows={identities.map((identity) => {
                const alert = recordedIdentityAlert(identity);
                return [
                  <span key="a">
                    {identity.account_ref ?? "no account id"}
                    <span className="block text-xs capitalize text-muted-foreground">
                      {identity.provider}
                    </span>
                  </span>,
                  <span
                    key="s"
                    className={identity.status === "error" ? "text-destructive" : undefined}
                  >
                    {identity.status}
                  </span>,
                  <span key="t" className="text-xs">
                    {identity.token_expires_at ? (
                      <>
                        {dayOrDash(identity.token_expires_at)}
                        <span
                          className={
                            Number(identity.days_left ?? 0) <= 7
                              ? "block text-destructive"
                              : "block text-muted-foreground"
                          }
                        >
                          {identity.days_left} days left
                        </span>
                      </>
                    ) : (
                      "no expiry recorded"
                    )}
                  </span>,
                  <span
                    key="w"
                    className={Number(identity.posts_waiting ?? 0) > 0 && alert ? "text-destructive" : undefined}
                  >
                    {identity.posts_waiting ?? 0} post
                    {Number(identity.posts_waiting ?? 0) === 1 ? "" : "s"}
                  </span>,
                  <span key="b" className={alert ? "text-destructive" : "text-muted-foreground"}>
                    {alert ?? "No status or expiry alert; credential and provider rights unverified"}
                  </span>,
                ];
              })}
            />
          )}
        </div>
      )}

      {tab === "profile" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Proposed changes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              What the profile says now, beside what we would make it say. Request review of the
              exact proposal in Approval Inbox. A Facebook Page field write needs a separate
              request and runtime release; Instagram profile fields remain manual.
            </p>
            <p role="status" className="mt-2 text-sm text-destructive">{PROFILE_FIELD_PATCH_HOLD}</p>
            {clientId && <Link className="mt-2 inline-block text-sm underline"
              to={`/clients/${clientId}/delivery/approval-inbox?tab=unified`}>
              Open Approval Inbox
            </Link>}
          </div>
          {changes.length === 0 && !loading ? (
            <EmptyState label="No profile change has been proposed" />
          ) : (
            <DataTable
              columns={["Field", "Says now", "Would say", "State", "Execution", "Review"]}
              emptyLabel={loading ? "Loading…" : "Nothing proposed"}
              rows={changes.map((change) => [
                <span key="f">
                  {change.field.replace(/_/g, " ")}
                  <span className="block text-xs capitalize text-muted-foreground">
                    {change.platform}
                  </span>
                </span>,
                <span key="c" className="text-xs text-muted-foreground">
                  {change.current_value ?? "empty"}
                </span>,
                <span key="p" className="text-xs">
                  {change.proposed_value}
                  {change.offer_version_id && (
                    <span className="block text-muted-foreground">from a signed offer</span>
                  )}
                </span>,
                <span
                  key="s"
                  className={
                    change.status === "approved"
                      ? "text-brand-strong"
                      : change.status === "rejected"
                        ? "text-destructive"
                        : undefined
                  }
                >
                  {change.status}
                  {change.status === "approved" && (
                    <span className="block text-xs text-muted-foreground">
                      {change.approved_request_id
                        ? profileDecisions.get(change.approved_request_id)?.status === "approved"
                          ? "Current exact Inbox decision; provider write held"
                          : `Inbox decision ${profileDecisions.get(change.approved_request_id)?.status ?? "unavailable"}; review again`
                        : "Pre-Inbox approval; review again"}
                    </span>
                  )}
                </span>,
                <span key="execution" className="text-xs text-muted-foreground">
                  {(() => {
                    const outcome = profileOutcomes.find((row) => row.change_id === change.id);
                    const job = profileJobs.find((row) => row.input_id === change.id
                      && row.agent_key === "meta_profile_field_writer");
                    const readJob = outcome && profileJobs.find((row) => row.input_id === outcome.attempt_id
                      && row.agent_key === "meta_profile_field_reconciler");
                    if (!outcome) return change.platform === "instagram"
                      ? "Manual profile edit required; no API writer."
                      : job ? `Queued job ${job.status.replace(/_/g, " ")}; runtime release may hold it.`
                        : "No provider write requested; adapter held.";
                    if (outcome.status === "confirmed") return `Provider readback confirmed · ${outcome.provider_ref ?? "reference unavailable"}`;
                    if (outcome.status === "uncertain") {
                      if (outcome.reconciliation_result === "matched")
                        return `Later readback matched the approved Page field · ${dayOrDash(outcome.reconciled_at)}`;
                      if (outcome.reconciliation_result === "different")
                        return `Later readback differs · ${dayOrDash(outcome.reconciled_at)}; inspect before any new proposal.`;
                      return readJob
                        ? `Provider outcome uncertain; read-only check ${readJob.status.replace(/_/g, " ")}.`
                        : "Provider outcome uncertain; request a read-only Page check.";
                    }
                    if (outcome.status === "refused") return "Provider write refused before start.";
                    if (outcome.status === "started") return "Provider write started; awaiting readback.";
                    return "One provider attempt reserved; prewrite pending.";
                  })()}
                </span>,
                <span key="review">
                  {change.status === "drafted" && <button type="button"
                    className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                    disabled={reviewBusy !== null}
                    onClick={() => void requestReview(change.id)}>
                    Request Inbox review
                  </button>}
                  {change.platform === "facebook" && change.status === "approved"
                    && change.approved_request_id
                    && profileDecisions.get(change.approved_request_id)?.status === "approved"
                    && !profileJobs.some((row) => row.input_id === change.id)
                    && !profileOutcomes.some((row) => row.change_id === change.id)
                    && <button type="button"
                      className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                      disabled={reviewBusy !== null}
                      onClick={() => void requestWrite(change.id)}>
                      Request Page write
                    </button>}
                  {(() => {
                    const outcome = profileOutcomes.find((row) => row.change_id === change.id);
                    const activeRead = profileJobs.some((row) => row.agent_key === "meta_profile_field_reconciler"
                      && row.input_id === outcome?.attempt_id
                      && ["queued", "claimed", "running", "paused"].includes(row.status));
                    return outcome?.status === "uncertain"
                      && outcome.attempt_id && outcome.reconciliation_result !== "matched"
                      && !activeRead && <button type="button"
                        className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                        disabled={reviewBusy !== null}
                        onClick={() => void requestReconciliation(outcome.attempt_id!)}>
                        Check Page read-only
                      </button>;
                  })()}
                </span>,
              ])}
            />
          )}
        </div>
      )}

      {tab === "presence" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Recorded Meta post activity, with its campaign, proof and provider read. Content
            Distribution owns publishing. A local published row is shown separately from
            verified presence on the exact provider account.
          </p>
          <DataTable
            columns={["Recorded post", "Platform", "Campaign", "Proof", "Provider read", "When"]}
            emptyLabel={loading ? "Loading…" : "No Meta post activity recorded"}
            rows={presence.map((post) => [
              <span key="p" className="text-xs">
                {post.external_url ? (
                  <a href={post.external_url} target="_blank" rel="noreferrer" className="underline">
                    {post.external_id ?? "view"}
                  </a>
                ) : (
                  (post.publication_status ?? "not published")
                )}
                <span className="block text-muted-foreground">
                  Local state: {post.publication_status ?? "unknown"}
                </span>
              </span>,
              <span key="l" className="capitalize">{post.platform}</span>,
              <span key="c" className="text-xs">{post.campaign_name ?? "no campaign"}</span>,
              <span key="r" className="text-xs">
                {post.proof_title ?? "none"}
                {post.carries_placed_proof && (
                  <span className="block text-brand-strong">proof placement recorded</span>
                )}
              </span>,
              <span key="read" className="text-xs">
                {presenceReadbackLabel(post)}
                {post.provider_readback_at && (
                  <span className="block text-muted-foreground">Read {dayOrDash(post.provider_readback_at)}</span>
                )}
              </span>,
              <span key="w">{dayOrDash(post.published_at ?? post.scheduled_at)}</span>,
            ])}
          />
          <div className="space-y-2">
            <h3 className="font-semibold">Paid Meta activity</h3>
            <p className="text-sm text-muted-foreground">
              The configured ad account's latest read, shared with Meta Ads Studio.
              Unknown metrics remain unknown when the provider did not return a row.
            </p>
            <MetaAdsReadPanel clientId={clientId} readOnly />
          </div>
        </div>
      )}
    </div>
  );
}
