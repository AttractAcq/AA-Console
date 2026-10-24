import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Identity = Database["public"]["Views"]["meta_identity_health"]["Row"];
type Presence = Database["public"]["Views"]["meta_profile_presence"]["Row"];
type ProfileChange = Database["public"]["Tables"]["meta_profile_changes"]["Row"];

type Tab = "identities" | "profile" | "presence";

/**
 * Meta Profile v2 — Identities, Profile and Presence.
 *
 * v1 reuses the organic post board and the organic metrics tab, which means
 * it answers neither question this page exists for. Is this client's account
 * actually connected? And does the profile hold up when somebody who just saw
 * an ad lands on it?
 *
 * The first was answerable all along and nothing asked it: the status, the
 * token expiry and the health detail were already on `client_integrations`,
 * and a disconnected account showed up as an empty post board —
 * indistinguishable from a client with nothing scheduled. So Identities leads,
 * and a broken credential comes with the count of what is waiting on it,
 * because a reconnect with a cost attached gets done.
 */
export function MetaProfilePanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [changes, setChanges] = useState<ProfileChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [health, posts, proposed] = await Promise.all([
        supabase.from("meta_identity_health").select("*").eq("client_id", clientId),
        supabase
          .from("meta_profile_presence")
          .select("*")
          .eq("client_id", clientId)
          .order("published_at", { ascending: false })
          .limit(100),
        supabase
          .from("meta_profile_changes")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
      ]);
      for (const result of [health, posts, proposed]) {
        if (result.error) throw new Error(result.error.message);
      }
      setIdentities(health.data ?? []);
      setPresence(posts.data ?? []);
      setChanges(proposed.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the profiles.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(change: ProfileChange, approved: boolean) {
    if (busy) return;
    const reason = approved ? undefined : window.prompt("Why is this change not going ahead?");
    if (!approved && !reason?.trim()) return;
    setBusy(change.id);
    setNotice(null);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc("decide_meta_profile_change_v6", {
        p_change_id: change.id,
        p_approved: approved,
        ...(reason?.trim() ? { p_reason: reason.trim() } : {}),
      });
      if (rpcError) throw new Error(rpcError.message);
      setNotice(
        approved
          ? "Approved. It waits for a Meta profile-write adapter, which does not exist yet."
          : "Rejected.",
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const broken = identities.filter((i) => i.blocker).length;

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "identities" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium">
              {identities.length === 0
                ? "No Meta identity is connected"
                : broken > 0
                  ? `${broken} of ${identities.length} identities need attention`
                  : `${identities.length} identit${identities.length === 1 ? "y" : "ies"} healthy`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              A disconnected account says so here rather than appearing as an empty post board.
              The count of what is waiting on it is attached, because a reconnect with a cost
              attached gets done.
            </p>
          </div>

          {identities.length === 0 && !loading ? (
            <EmptyState label="Connect Instagram or Facebook on the Integrations page" />
          ) : (
            <DataTable
              columns={["Account", "Status", "Token", "Waiting on it", "What is stopping it"]}
              emptyLabel={loading ? "Loading…" : "No identities"}
              rows={identities.map((identity) => [
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
                  className={Number(identity.posts_waiting ?? 0) > 0 && identity.blocker ? "text-destructive" : undefined}
                >
                  {identity.posts_waiting ?? 0} post
                  {Number(identity.posts_waiting ?? 0) === 1 ? "" : "s"}
                </span>,
                <span key="b" className={identity.blocker ? "text-destructive" : "text-brand-strong"}>
                  {identity.blocker ?? "Nothing"}
                </span>,
              ])}
            />
          )}
        </div>
      )}

      {tab === "profile" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Proposed changes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              What the profile says now, beside what we would make it say. An approved change
              waits for a Meta profile-write adapter, which this runtime does not have — so
              approval records the decision rather than applying it, and this page says so instead
              of offering a button that would fail.
            </p>
          </div>
          {changes.length === 0 && !loading ? (
            <EmptyState label="No profile change has been proposed" />
          ) : (
            <DataTable
              columns={["Field", "Says now", "Would say", "State", "Actions"]}
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
                      waiting for an adapter
                    </span>
                  )}
                </span>,
                <span key="a" className="flex gap-2">
                  {change.status === "drafted" && (
                    <>
                      <Button disabled={busy === change.id} onClick={() => void decide(change, true)}>
                        Approve
                      </Button>
                      <Button disabled={busy === change.id} onClick={() => void decide(change, false)}>
                        Reject
                      </Button>
                    </>
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
