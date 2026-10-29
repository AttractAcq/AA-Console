import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { dayOrDash } from "../../lib/contentRecords";
import {
  fetchCreativeAuthority, fetchCreativeDecisions, setCreativeDirectorRequired,
  type CreativeAuthority, type CreativeDecision,
} from "../../lib/creativeAuthority";

/**
 * Who holds the creative seats for this client — G12.
 *
 * Shown on the queue where creative is actually approved, because that is
 * where the question arises. It says three things that were previously
 * unsayable: who the creative director is, that the "video approval manager"
 * every other screen refers to is in fact the assigned SMM, and which seat
 * each recent decision was made from.
 *
 * The requirement toggle is deliberately plain and deliberately explains
 * itself: turning it on changes who may approve creative for a real client,
 * and a switch that quietly narrows permissions is worse than no switch.
 */
export function CreativeAuthorityStrip() {
  const { clientId } = useParams<{ clientId: string }>();
  const [authority, setAuthority] = useState<CreativeAuthority | null>(null);
  const [decisions, setDecisions] = useState<CreativeDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    try {
      const [seats, recent] = await Promise.all([
        fetchCreativeAuthority(clientId),
        fetchCreativeDecisions(clientId),
      ]);
      setAuthority(seats);
      setDecisions(recent);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the creative seats.");
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async () => {
    if (!clientId || !authority) return;
    setBusy(true);
    try {
      await setCreativeDirectorRequired(clientId, !authority.creative_director_required);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the requirement.");
    } finally {
      setBusy(false);
    }
  };

  if (!authority && !error) return null;

  const required = authority?.creative_director_required === true;
  const unseated = decisions.filter((d) => d.seat === "other").length;

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-semibold">Who decides this is good enough</h3>
        {required && (
          <span className="text-xs font-medium text-brand-strong">
            Creative director sign-off required
          </span>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Creative director</dt>
          <dd className="font-mono">
            {authority?.creative_director_user_id ?? "nobody assigned"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Assigned SMM — what every screen calls the &ldquo;video approval manager&rdquo;
          </dt>
          <dd className="font-mono">{authority?.smm_user_id ?? "nobody assigned"}</dd>
        </div>
      </dl>

      {authority?.problem && (
        <p role="alert" className="text-sm text-amber-600">{authority.problem}</p>
      )}

      {unseated > 0 && (
        <p className="text-xs text-muted-foreground">
          {unseated} of the last {decisions.length} decisions were made by somebody holding no
          named seat. That is allowed; it is shown because a pattern of it is worth noticing.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void toggle()}>
          {required ? "Stop requiring a creative director" : "Require a creative director"}
        </Button>
        <Button onClick={() => setOpen((v) => !v)}>
          {open ? "Hide decisions" : "Recent decisions"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {required
          ? "Approvals must come from the assigned creative director or an admin. Rejections are never blocked — refusing work needs no authority."
          : "Anyone with access to this client can approve creative. The seat each decision was made from is recorded either way."}
      </p>

      {open && (
        <DataTable
          columns={["When", "Asset", "Decision", "Seat"]}
          emptyLabel="No creative decision has been recorded yet"
          rows={decisions.map((d) => [
            <span key="w" className="text-xs">{dayOrDash(d.decided_at)}</span>,
            <span key="a" className="text-xs">{d.asset_title ?? "Untitled"}</span>,
            <span
              key="d"
              className={d.decision === "approved" ? "text-xs text-brand-strong" : "text-xs"}
            >
              {d.decision}
            </span>,
            <span
              key="s"
              className={
                d.seat === "other" || d.seat === "unrecorded"
                  ? "font-mono text-xs text-muted-foreground"
                  : "font-mono text-xs"
              }
            >
              {d.seat}
            </span>,
          ])}
        />
      )}
    </section>
  );
}
