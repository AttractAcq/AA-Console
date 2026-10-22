import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { fetchProofAssets, type ProofAsset } from "../../lib/media";
import { requestProofPublish } from "../../lib/campaignActions";
import { supabase } from "../../lib/supabase";
import {
  LIVE_STATUSES, MODE_HINT,
  createPlacement, decideApproval, fetchClientDestinations, fetchDestinations,
  fetchPlacementDue, fetchPlacements, markPlacedByHand, recordRetracted,
  requestApproval, setDestinationEnabled, setProofPublishingEnabled,
  type ClientDestination, type Destination, type Placement, type PlacementDue,
} from "../../lib/proofDistribution";

/**
 * Proof Distribution.
 *
 * The Proof Production Factory can clear a testimonial, record who gave
 * permission and turn it into a GEO answer. Until this screen it then
 * stopped: nothing recorded a piece of proof being *present* anywhere, so
 * "where is this testimonial used" and "this permission expired, what do we
 * pull" were both unanswerable.
 *
 * Three tabs, and they are three questions:
 *
 *   Destinations  where can proof go, and is this client switched on for it
 *   Placements    what is going where, and what is stopping each one
 *   Rights        what is live, on whose permission, and what has to come down
 *
 * Rights is the tab that justifies the rest. A placement is cheap to make and
 * expensive to forget, and permission ending is the moment the record earns
 * its keep.
 */

type Tab = "destinations" | "placements" | "rights";

export function ProofDistributionPanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [clientDestinations, setClientDestinations] = useState<ReadonlyMap<string, ClientDestination>>(new Map());
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [due, setDue] = useState<ReadonlyMap<string, PlacementDue>>(new Map());
  const [proof, setProof] = useState<ProofAsset[]>([]);
  const [publishingOn, setPublishingOn] = useState(false);
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
      const [all, mine, rows, blockers, proofRows, settings] = await Promise.all([
        fetchDestinations(),
        fetchClientDestinations(clientId),
        fetchPlacements(clientId),
        fetchPlacementDue(clientId),
        fetchProofAssets(clientId),
        supabase.from("client_engine_settings")
          .select("proof_publishing_enabled").eq("client_id", clientId).maybeSingle(),
      ]);
      setDestinations(all);
      setClientDestinations(mine);
      setPlacements(rows);
      setDue(blockers);
      setProof(proofRows);
      setPublishingOn(Boolean((settings.data as { proof_publishing_enabled?: boolean } | null)?.proof_publishing_enabled));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load proof distribution.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(key: string, work: () => Promise<void>, said: string) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await work();
      setNotice(said);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const titleOf = (id: string) => proof.find((p) => p.id === id)?.title ?? "Untitled proof";

  if (error && placements.length === 0 && destinations.length === 0) {
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "destinations" && (
        <DestinationsTab
          clientId={clientId}
          destinations={destinations}
          mine={clientDestinations}
          publishingOn={publishingOn}
          placements={placements}
          busy={busy}
          loading={loading}
          onAct={act}
        />
      )}
      {tab === "placements" && (
        <PlacementsTab
          placements={placements}
          due={due}
          destinations={destinations}
          titleOf={titleOf}
          busy={busy}
          loading={loading}
          onAct={act}
        />
      )}
      {tab === "rights" && (
        <RightsTab
          placements={placements}
          due={due}
          proof={proof}
          titleOf={titleOf}
          busy={busy}
          loading={loading}
          onAct={act}
        />
      )}
    </div>
  );
}

function DestinationsTab({
  clientId, destinations, mine, publishingOn, placements, busy, loading, onAct,
}: {
  clientId: string | undefined;
  destinations: Destination[];
  mine: ReadonlyMap<string, ClientDestination>;
  publishingOn: boolean;
  placements: Placement[];
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    counts.set(placement.destination_key, (counts.get(placement.destination_key) ?? 0) + 1);
  }

  return (
    <div className="space-y-5">
      {/* The second of the switches, and the one this screen owns. The
          runtime's own flag is the first, and both have to be on. Separate
          from the social publishing switch on purpose: posting on a client's
          feed and putting their customer's words on somebody else's profile
          are different promises. */}
      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-card-foreground">
              {publishingOn
                ? "Cleared proof may be placed for this client"
                : "Nothing is placed anywhere for this client"}
            </p>
            <p className="text-sm text-muted-foreground">
              {publishingOn
                ? "An approved placement goes out on the next sweep, if its destination has an adapter and the runtime is switched on too."
                : "Placements can be drafted and approved. Nothing reaches anywhere outside this console."}
            </p>
          </div>
          <button
            type="button"
            disabled={!clientId || busy !== null}
            onClick={() =>
              void onAct(
                "switch",
                () => setProofPublishingEnabled(clientId!, !publishingOn),
                publishingOn ? "Proof distribution is off for this client." : "Proof distribution is on for this client.",
              )
            }
            className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
              publishingOn ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {publishingOn ? "Switch off" : "Switch on"}
          </button>
        </div>
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading destinations…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {destinations.map((destination) => {
            const row = mine.get(destination.destination_key);
            const on = row?.enabled ?? false;
            return (
              <article key={destination.destination_key} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold">{destination.label}</h3>
                    <p className="text-xs text-muted-foreground">
                      <span className="capitalize">{destination.mode}</span> · {MODE_HINT[destination.mode]}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      destination.supported
                        ? "bg-primary/10 text-brand-strong"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    {destination.supported ? "Adapter ready" : "No adapter yet"}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{destination.note}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {counts.get(destination.destination_key) ?? 0} placement
                  {(counts.get(destination.destination_key) ?? 0) === 1 ? "" : "s"}
                  {destination.requires_integration && destination.provider
                    ? ` · needs a ${destination.provider} integration`
                    : ""}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!clientId || busy !== null}
                    onClick={() =>
                      void onAct(
                        destination.destination_key,
                        () => setDestinationEnabled(clientId!, destination.destination_key, !on, row?.account_ref),
                        on ? `${destination.label} is off for this client.` : `${destination.label} is on for this client.`,
                      )
                    }
                    className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {on ? "Switch off for this client" : "Switch on for this client"}
                  </button>
                  {on && (
                    <span className="text-xs text-muted-foreground">
                      {row?.account_ref ? `Account: ${row.account_ref}` : "No account reference recorded"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlacementsTab({
  placements, due, destinations, titleOf, busy, loading, onAct,
}: {
  placements: Placement[];
  due: ReadonlyMap<string, PlacementDue>;
  destinations: Destination[];
  titleOf: (id: string) => string;
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const modeOf = (key: string) => destinations.find((d) => d.destination_key === key)?.mode;
  const labelOf = (key: string) => destinations.find((d) => d.destination_key === key)?.label ?? key;

  if (!loading && placements.length === 0) {
    return (
      <EmptyState label="No placements yet — send an approved proof artifact to a destination from Proof Artifacts" />
    );
  }

  return (
    <DataTable
      columns={["Proof", "Destination", "Status", "What is stopping it", "Placed", "Actions"]}
      emptyLabel={loading ? "Loading placements…" : "No placements yet"}
      rows={placements.map((placement) => {
        const blocker = due.get(placement.id)?.blocker ?? null;
        const mode = modeOf(placement.destination_key);
        return [
          <span key="p">{titleOf(placement.source_proof_id)}</span>,
          <span key="d">
            {labelOf(placement.destination_key)}
            <span className="block text-xs capitalize text-muted-foreground">{mode}</span>
          </span>,
          <span key="s">{placement.status.replace(/_/g, " ")}</span>,
          <span key="b" className={blocker || placement.last_error ? "text-destructive" : "text-brand-strong"}>
            {/* A failed or rejected placement is outside the due view, so its
                blocker is null while the thing a person needs to read sits in
                last_error. Showing "Nothing" there said the opposite of the
                truth. */}
            {blocker ??
              (placement.status === "failed" && placement.last_error
                ? placement.last_error
                : LIVE_STATUSES.has(placement.status)
                  ? "Live"
                  : "Nothing")}
          </span>,
          <span key="w">
            {placement.external_url ? (
              <a href={placement.external_url} target="_blank" rel="noreferrer" className="hover:underline">
                {dayOrDash(placement.placed_at)}
              </a>
            ) : (
              dayOrDash(placement.placed_at)
            )}
          </span>,
          <ActionMenu
            key="a"
            name={`${titleOf(placement.source_proof_id)} at ${labelOf(placement.destination_key)}`}
            busy={busy === placement.id}
            items={[
              ...(placement.status === "drafted"
                ? [{
                    label: "Ask for approval",
                    onSelect: () =>
                      void onAct(placement.id, () => requestApproval(placement.id), "Sent for approval."),
                  }]
                : []),
              // A campaign-bound draft can instead be asked for as one
              // campaign decision covering every drafted placement on that
              // campaign. One person answering once about a named set of
              // payloads, rather than the same person answering the same
              // question six times in two queues.
              ...(placement.status === "drafted" && placement.campaign_id
                ? [{
                    label: "Ask as one campaign decision",
                    onSelect: () =>
                      void onAct(
                        placement.id,
                        async () => {
                          await requestProofPublish(placement.client_id, placement.campaign_id!);
                        },
                        "Asked in the Approval Inbox, under Campaign actions.",
                      ),
                  }]
                : []),
              ...(placement.status === "awaiting_approval" && placement.approval_id
                ? [
                    {
                      label: "Approve this placement",
                      onSelect: () =>
                        void onAct(placement.id, () => decideApproval(placement.approval_id!, true), "Approved."),
                    },
                    {
                      label: "Reject it",
                      onSelect: () => {
                        const why = window.prompt("Why is this not going out?");
                        if (why?.trim()) {
                          void onAct(
                            placement.id,
                            () => decideApproval(placement.approval_id!, false, why.trim()),
                            "Rejected.",
                          );
                        }
                      },
                    },
                  ]
                : []),
              // Only an assisted destination is placed by hand. The database
              // refuses it for any other mode, so the action is not offered.
              ...(placement.status === "awaiting_manual_placement" && mode === "assisted"
                ? [{
                    label: "Mark placed",
                    onSelect: () => {
                      const url = window.prompt("Where was it placed? Paste the URL.");
                      if (url?.trim()) {
                        void onAct(
                          placement.id,
                          () => markPlacedByHand(placement.id, url.trim()),
                          "Recorded.",
                        );
                      }
                    },
                  }]
                : []),
              ...(LIVE_STATUSES.has(placement.status) || placement.status === "retraction_required"
                ? [{
                    label: "Record as taken down",
                    destructive: true,
                    onSelect: () => {
                      const why = window.prompt("Why is it coming down?");
                      void onAct(
                        placement.id,
                        () => recordRetracted(placement.id, why?.trim() || undefined),
                        "Recorded as retracted.",
                      );
                    },
                  }]
                : []),
            ]}
          />,
        ];
      })}
    />
  );
}

function RightsTab({
  placements, due, proof, titleOf, busy, loading, onAct,
}: {
  placements: Placement[];
  due: ReadonlyMap<string, PlacementDue>;
  proof: ProofAsset[];
  titleOf: (id: string) => string;
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const needsRetraction = placements.filter((p) => p.status === "retraction_required");
  const live = placements.filter((p) => LIVE_STATUSES.has(p.status));
  const bySource = new Map<string, Placement[]>();
  for (const placement of live) {
    bySource.set(placement.source_proof_id, [...(bySource.get(placement.source_proof_id) ?? []), placement]);
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {/* First, because it is the only part of this screen that is a job
          rather than a record. Permission ending while something is live is
          the case the whole table exists for. */}
      <section className="space-y-2">
        <h3 className="font-semibold">Needs taking down</h3>
        {needsRetraction.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing. Every live placement rests on proof that is still cleared.
          </p>
        ) : (
          <DataTable
            columns={["Proof", "Destination", "Where", "Actions"]}
            emptyLabel=""
            rows={needsRetraction.map((placement) => [
              <span key="p">{titleOf(placement.source_proof_id)}</span>,
              <span key="d">{due.get(placement.id)?.destination_label ?? placement.destination_key}</span>,
              <span key="u">
                {placement.external_url ? (
                  <a href={placement.external_url} target="_blank" rel="noreferrer" className="hover:underline">
                    {placement.external_url}
                  </a>
                ) : (
                  "Not recorded"
                )}
              </span>,
              <ActionMenu
                key="a"
                name={titleOf(placement.source_proof_id)}
                busy={busy === placement.id}
                items={[{
                  label: "Record as taken down",
                  destructive: true,
                  onSelect: () => {
                    const why = window.prompt("Why is it coming down?");
                    void onAct(
                      placement.id,
                      () => recordRetracted(placement.id, why?.trim() || undefined),
                      "Recorded as retracted.",
                    );
                  },
                }]}
              />,
            ])}
          />
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">What is live, and on whose permission</h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : bySource.size === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is placed anywhere yet.</p>
        ) : (
          <div className="space-y-3">
            {[...bySource.entries()].map(([sourceId, rows]) => {
              const source = proof.find((p) => p.id === sourceId);
              const expiring = source?.expires_on && source.expires_on >= today;
              const expired = source?.expires_on && source.expires_on < today;
              return (
                <article key={sourceId} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 className="font-medium">{titleOf(sourceId)}</h4>
                    <span className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
                      {source?.expires_on
                        ? `${expired ? "Permission expired" : "Permission expires"} ${source.expires_on}`
                        : "No expiry recorded"}
                      {expiring ? "" : ""}
                    </span>
                  </div>
                  {source?.permission_basis && (
                    <p className="mt-1 text-xs text-muted-foreground">On: {source.permission_basis}</p>
                  )}
                  <ul className="mt-2 space-y-1">
                    {rows.map((placement) => (
                      <li key={placement.id} className="text-sm">
                        {due.get(placement.id)?.destination_label ?? placement.destination_key}
                        {placement.external_url && (
                          <>
                            {" · "}
                            <a href={placement.external_url} target="_blank" rel="noreferrer" className="hover:underline">
                              look at it
                            </a>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** Exported for Proof Artifacts, which is where a placement starts. */
export { createPlacement };
