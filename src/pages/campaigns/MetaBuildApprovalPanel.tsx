import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { callRuntime } from "../../lib/callRuntime";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type BuildDue = Database["public"]["Views"]["meta_build_due"]["Row"];

/**
 * Meta Ads Studio v2 — Build.
 *
 * v1 can already create paused campaign, ad set, creative and ad objects on a
 * real account. For a v6 campaign it refused outright, and correctly: a
 * paused object is still an external write, and Meta object creation is not
 * idempotent, so a second run makes a second campaign somebody pays for.
 *
 * What this board adds is the decision that lifts the refusal, and the three
 * facts that make it meaningful: what the build would put on the account,
 * whether that still matches what was signed off, and whether objects already
 * exist. Activation is deliberately absent — turning on spend is its own
 * approval, and shipping it as a side effect of making the build work would
 * be exactly the wrong order.
 */
export function MetaBuildApprovalPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [due, setDue] = useState<BuildDue[]>([]);
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
      const { data, error: queryError } = await supabase
        .from("meta_build_due")
        .select("*")
        .eq("client_id", clientId);
      if (queryError) throw new Error(queryError.message);
      setDue(data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Meta builds.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function ask(campaignId: string) {
    if (!clientId || busy) return;
    setBusy(campaignId);
    setNotice(null);
    setError(null);
    try {
      await callRuntime<{ approvalId: string }>("/admin/campaign-actions/request", {
        clientId,
        campaignId,
        actionKey: "meta_ad_build",
      });
      setNotice("Asked. It is in the Approval Inbox, under Campaign actions.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not ask for that build.");
    } finally {
      setBusy(null);
    }
  }

  const built = due.filter((row) => row.meta_campaign_id).length;
  const drifted = due.filter((row) =>
    row.blocker?.includes("changed after approval"),
  ).length;

  if (error && due.length === 0 && !loading) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button onClick={() => void refresh()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium">
          {built} built
          {drifted > 0 && ` · ${drifted} changed since approval`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A build creates paused objects, which is still an external write. Built is not live:
          activation is a separate approval, and so is every budget change. Meta object creation
          is not idempotent, so a campaign that already has objects will not be built again.
        </p>
      </div>

      {due.length === 0 && !loading ? (
        <EmptyState label="No paid Meta campaign yet — create one in Campaign Factory" />
      ) : (
        <DataTable
          columns={["Campaign", "Creative", "Approval", "What is stopping it", "Meta objects", "Actions"]}
          emptyLabel={loading ? "Loading…" : "Nothing yet"}
          rows={due.map((row) => {
            const drifted = row.blocker?.includes("changed after approval") ?? false;
            const ready = row.blocker === null;
            const builtAlready = Boolean(row.meta_campaign_id);
            return [
              <span key="c">
                {row.name}
                {row.campaign_id && clientId && (
                  <Link
                    className="block text-xs text-brand-strong underline"
                    to={`/clients/${clientId}/delivery/campaign-factory/${row.campaign_id}`}
                  >
                    View campaign
                  </Link>
                )}
              </span>,
              <span key="r">{row.approved_creative ?? 0} approved</span>,
              <span key="a" className="text-xs">
                {row.approval_status ?? "not asked"}
                {row.approved_hash && (
                  <span className="block font-mono text-muted-foreground">
                    {row.approved_hash.slice(0, 12)}…
                  </span>
                )}
              </span>,
              <span
                key="b"
                className={
                  drifted
                    ? "text-destructive"
                    : ready
                      ? "text-brand-strong"
                      : builtAlready
                        ? "text-muted-foreground"
                        : "text-amber-600"
                }
              >
                {row.blocker ?? "Ready to build on the next sweep"}
              </span>,
              <span key="m" className="text-xs">
                {row.meta_campaign_id ? (
                  <>
                    <span className="font-mono">{row.meta_campaign_id}</span>
                    <span className="block text-muted-foreground">
                      {row.meta_ad_set_id ? `ad set ${row.meta_ad_set_id}` : "ad set pending"}
                      {row.meta_built_at && ` · ${dayOrDash(row.meta_built_at)}`}
                    </span>
                  </>
                ) : (
                  "none"
                )}
              </span>,
              <span key="x">
                {!builtAlready &&
                  (row.approval_status === null || drifted) && (
                    <Button
                      disabled={busy === row.campaign_id}
                      onClick={() => row.campaign_id && void ask(row.campaign_id)}
                    >
                      {drifted ? "Ask again" : "Ask for approval"}
                    </Button>
                  )}
              </span>,
            ];
          })}
        />
      )}
    </div>
  );
}
