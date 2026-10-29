import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type PublishDue = Database["public"]["Views"]["campaign_page_publish_due"]["Row"];
type Publication = Database["public"]["Tables"]["campaign_page_publications"]["Row"];

/**
 * Website Studio v2 — Publish.
 *
 * v1 builds, revises and previews pages, and for a v6 campaign page the last
 * step was deliberately missing: migration 212 blocked publication until an
 * exact-version executor existed. It exists now, so this is the board that
 * shows what happened to each decision.
 *
 * The distinction the layout exists to protect is between published and
 * working. A page whose form posts nowhere looks exactly like one that works
 * — same commit, same URL, same screenshot — so "Published. Nobody has
 * tested the form yet." is its own row state here, and deliberately not the
 * same colour as live and tested.
 */
export function CampaignPagePublishPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [due, setDue] = useState<PublishDue[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [board, published] = await Promise.all([
        supabase.from("campaign_page_publish_due").select("*").eq("client_id", clientId),
        supabase
          .from("campaign_page_publications")
          .select("*")
          .eq("client_id", clientId)
          .order("published_at", { ascending: false }),
      ]);
      if (board.error) throw new Error(board.error.message);
      if (published.error) throw new Error(published.error.message);
      setDue(board.data ?? []);
      setPublications(published.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load page publications.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Published, probed and passing. The only state that earns the word live. */
  const live = due.filter((row) => row.blocker === "Live and tested.").length;
  const untested = due.filter(
    (row) => row.blocker === "Published. Nobody has tested the form yet.",
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
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium">
          {live} live and tested
          {untested > 0 && ` · ${untested} published but untested`}
          {due.length === 0 && " · nothing has been approved for publication yet"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A page is published when a commit exists and working when a test submission reaches
          Sales OS carrying its campaign, source and consent. Those are different facts, so they
          are different states here.
        </p>
      </div>

      {due.length === 0 && !loading ? (
        <EmptyState label="No page deployment has been approved — ask for one from the campaign" />
      ) : (
        <DataTable
          columns={["Page", "Destination", "State", "Commit", "Approved bytes"]}
          emptyLabel={loading ? "Loading…" : "Nothing approved yet"}
          rows={due.map((row) => {
            const good = row.blocker === "Live and tested." || row.blocker === null;
            const warn = row.blocker?.startsWith("Published.");
            return [
              <span key="p">
                {row.site_path ?? "—"}
                {row.campaign_id && clientId && (
                  <Link
                    className="block text-xs text-brand-strong underline"
                    to={`/clients/${clientId}/delivery/campaign-factory/${row.campaign_id}`}
                  >
                    View campaign
                  </Link>
                )}
              </span>,
              <span key="d" className="text-xs">
                {row.published_url ? (
                  <a href={row.published_url} target="_blank" rel="noreferrer" className="underline">
                    {row.published_url}
                  </a>
                ) : (
                  "not published"
                )}
              </span>,
              <span
                key="s"
                className={good ? "text-brand-strong" : warn ? "text-amber-600" : "text-destructive"}
              >
                {row.blocker ?? "Ready to publish on the next sweep"}
                {row.probe_detail && (
                  <span className="block text-xs text-muted-foreground">{row.probe_detail}</span>
                )}
              </span>,
              <span key="c" className="font-mono text-xs">
                {row.commit_sha?.slice(0, 7) ?? "—"}
              </span>,
              <span key="h" className="font-mono text-xs">
                {row.rendered_sha256?.slice(0, 12)}…
              </span>,
            ];
          })}
        />
      )}

      {publications.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Every commit, in order</h3>
          <DataTable
            columns={["When", "URL", "Commit", "Form probe"]}
            emptyLabel="Nothing published yet"
            rows={publications.map((p) => [
              <span key="w">{dayOrDash(p.published_at)}</span>,
              <span key="u" className="text-xs">
                <a href={p.published_url} target="_blank" rel="noreferrer" className="underline">
                  {p.published_url}
                </a>
              </span>,
              <span key="c" className="font-mono text-xs">
                {p.commit_sha.slice(0, 7)}
              </span>,
              <span
                key="p"
                className={
                  p.probe_status === "passed"
                    ? "text-brand-strong"
                    : p.probe_status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }
              >
                {p.probe_status ?? "not tested"}
                {p.probe_detail && (
                  <span className="block text-xs text-muted-foreground">{p.probe_detail}</span>
                )}
              </span>,
            ])}
          />
        </section>
      )}
    </div>
  );
}
