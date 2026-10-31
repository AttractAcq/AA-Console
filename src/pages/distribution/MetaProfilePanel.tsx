import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { PROFILE_FIELD_PATCH_HOLD } from "../../../agent-runtime/src/profiles/prewrite-gate.js";

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
  "id" | "platform" | "field" | "current_value" | "proposed_value" | "offer_version_id" | "status" | "created_at"
>;

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
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [changes, setChanges] = useState<ProfileChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [health, posts, proposed] = await Promise.all([
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
          .select("id,platform,field,current_value,proposed_value,offer_version_id,status,created_at")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
      ]);
      for (const result of [health, posts, proposed]) {
        if (result.error) throw new Error("Profile read failed.");
      }
      setIdentities(health.data ?? []);
      setPresence(posts.data ?? []);
      setChanges(proposed.data ?? []);
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
              What the profile says now, beside what we would make it say. Direct decisions are
              held until each exact proposal is bound to the unified Approval Inbox with AAL2
              approval. This runtime also has no Meta profile-write adapter, so no field change
              can be applied from this page.
            </p>
            <p role="status" className="mt-2 text-sm text-destructive">{PROFILE_FIELD_PATCH_HOLD}</p>
          </div>
          {changes.length === 0 && !loading ? (
            <EmptyState label="No profile change has been proposed" />
          ) : (
            <DataTable
              columns={["Field", "Says now", "Would say", "State"]}
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
                      held for Inbox binding and an adapter; no field PATCH
                    </span>
                  )}
                </span>,
              ])}
            />
          )}
        </div>
      )}

      {tab === "presence" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            What is on the profiles, with the campaign and the proof behind each post. Content
            Distribution owns publishing; this says what is present — and marks the posts carrying
            placed proof, because those are the ones that would have to come down if permission
            ended.
          </p>
          <DataTable
            columns={["Post", "Platform", "Campaign", "Proof", "When"]}
            emptyLabel={loading ? "Loading…" : "Nothing has been published to a Meta profile"}
            rows={presence.map((post) => [
              <span key="p" className="text-xs">
                {post.external_url ? (
                  <a href={post.external_url} target="_blank" rel="noreferrer" className="underline">
                    {post.external_id ?? "view"}
                  </a>
                ) : (
                  (post.publication_status ?? "not published")
                )}
              </span>,
              <span key="l" className="capitalize">{post.platform}</span>,
              <span key="c" className="text-xs">{post.campaign_name ?? "no campaign"}</span>,
              <span key="r" className="text-xs">
                {post.proof_title ?? "none"}
                {post.carries_placed_proof && (
                  <span className="block text-brand-strong">placed proof</span>
                )}
              </span>,
              <span key="w">{dayOrDash(post.published_at ?? post.scheduled_at)}</span>,
            ])}
          />
        </div>
      )}
    </div>
  );
}
