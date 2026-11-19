import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { fetchProofAssets, type ProofAsset } from "../../lib/media";
import { requestProofPublish } from "../../lib/campaignActions";
import { supabase } from "../../lib/supabase";
import {
  LIVE_STATUSES, MODE_HINT,
  createPlacement, fetchClientDestinations, fetchDestinations,
  fetchPlacementDue, fetchPlacements, fetchPlacementEvents, fetchRetractionReceipts,
  markPlacedByHand, recordRetracted, auditLegacyRetraction,
  requestApproval, setDestinationEnabled, setProofPublishingEnabled,
  fetchProofSurfaceCoverage,
  destinationPreflight,
  type ClientDestination, type Destination, type Placement, type PlacementDue,
  type DestinationIntegration,
  type RetractionReceipt, type PlacementEvent,
  type ProofSurfaceCoverage,
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
 * Two tabs answer the operating questions:
 *
 *   Destinations  where can proof go, and is this client switched on for it
 *   Distribution Log  what went where, with its rights, blockers and history
 *
 * The former Rights view stays in the log because permission ending while a
 * placement is live still needs a visible removal task.
 */

type Tab = "destinations" | "placements" | "rights";

function confirmProofRemoval(
  placement: Placement,
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>,
) {
  const reason = window.prompt("Why is this proof placement being removed?")?.trim();
  if (!reason) return;
  const wasLive = LIVE_STATUSES.has(placement.status) || Boolean(
    placement.placed_at || placement.external_id || placement.external_url);
  const evidenceRef = wasLive
    ? window.prompt("Where did you confirm removal? Paste the provider URL, ticket, or screenshot reference.")?.trim()
    : null;
  if (wasLive && !evidenceRef) return;
  void onAct(placement.id, () => recordRetracted(placement.id, {
    method: wasLive ? "human_checked" : "cancelled_before_placement",
    reason, evidenceRef,
  }), wasLive ? "Human removal confirmation recorded." : "Unplaced proof cancelled.");
}

function auditLegacyProofRemoval(
  placement: Placement,
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>,
) {
  const reason = window.prompt("Why was this historical placement removed?")?.trim();
  if (!reason) return;
  const evidenceRef = window.prompt(
    "Where did you verify that the historical placement is no longer live? Paste a provider URL, ticket, or screenshot reference.",
  )?.trim();
  if (!evidenceRef) return;
  void onAct(placement.id, () => auditLegacyRetraction(placement.id, evidenceRef, reason),
    "Later human removal confirmation recorded.");
}

export function ProofDistributionPanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  return <ClientProofDistributionPanel key={clientId ?? "no-client"} clientId={clientId} tab={tab} />;
}

function ClientProofDistributionPanel({ clientId, tab }: { clientId: string | undefined; tab: Tab }) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [clientDestinations, setClientDestinations] = useState<ReadonlyMap<string, ClientDestination>>(new Map());
  const [integrations, setIntegrations] = useState<DestinationIntegration[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [retractionReceipts, setRetractionReceipts] = useState<ReadonlyMap<string, RetractionReceipt>>(new Map());
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
      const [all, mine, rows, receipts, blockers, proofRows, settings, connected] = await Promise.all([
        fetchDestinations(),
        fetchClientDestinations(clientId),
        fetchPlacements(clientId),
        fetchRetractionReceipts(clientId),
        fetchPlacementDue(clientId),
        fetchProofAssets(clientId),
        supabase.from("client_engine_settings")
          .select("proof_publishing_enabled").eq("client_id", clientId).maybeSingle(),
        supabase.from("client_integrations")
          .select("provider, status, credential_secret_id, token_expires_at").eq("client_id", clientId),
      ]);
      if (connected.error) throw connected.error;
      setDestinations(all);
      setClientDestinations(mine);
      setIntegrations((connected.data ?? []) as DestinationIntegration[]);
      setPlacements(rows);
      setRetractionReceipts(receipts);
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
          integrations={integrations}
          publishingOn={publishingOn}
          placements={placements}
          busy={busy}
          loading={loading}
          onAct={act}
        />
      )}
      {tab === "placements" && (
        <div className="space-y-8">
          <RightsTab
            placements={placements}
            retractionReceipts={retractionReceipts}
            due={due}
            proof={proof}
            titleOf={titleOf}
            busy={busy}
            loading={loading}
            onAct={act}
          />
          <section className="space-y-3" aria-label="Distribution log">
            <h3 className="font-semibold">Distribution log</h3>
            <PlacementsTab
              placements={placements}
              retractionReceipts={retractionReceipts}
              due={due}
              destinations={destinations}
              proof={proof}
              titleOf={titleOf}
              busy={busy}
              loading={loading}
              onAct={act}
            />
          </section>
        </div>
      )}
      {tab === "rights" && (
        <RightsTab
          placements={placements}
          retractionReceipts={retractionReceipts}
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
  clientId, destinations, mine, integrations, publishingOn, placements, busy, loading, onAct,
}: {
  clientId: string | undefined;
  destinations: Destination[];
  mine: ReadonlyMap<string, ClientDestination>;
  integrations: DestinationIntegration[];
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
                publishingOn ? "Proof distribution is off for this client." : "Exact activation review requested in Unified Approval Inbox.",
              )
            }
            className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
              publishingOn ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {publishingOn ? "Switch off" : "Request activation"}
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
            const preflight = destinationPreflight(destination, row, integrations);
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
                    {destination.supported ? "Route implemented" : "No adapter yet"}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{destination.note}</p>
                <div className="mt-2 text-xs" aria-label={`${destination.label} preflight`}>
                  {preflight.length ? preflight.map((reason) => <p key={reason} className="text-destructive">{reason}</p>)
                    : <p className="text-amber-700">Recorded setup is present. Account rights and provider action remain unverified until live preflight and read-back.</p>}
                </div>
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
  placements, retractionReceipts, due, destinations, proof, titleOf, busy, loading, onAct,
}: {
  placements: Placement[];
  retractionReceipts: ReadonlyMap<string, RetractionReceipt>;
  due: ReadonlyMap<string, PlacementDue>;
  destinations: Destination[];
  proof: ProofAsset[];
  titleOf: (id: string) => string;
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<PlacementEvent[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const modeOf = (key: string) => destinations.find((d) => d.destination_key === key)?.mode;
  const labelOf = (key: string) => destinations.find((d) => d.destination_key === key)?.label ?? key;
  const proofOf = (id: string) => proof.find((item) => item.id === id);

  const loadHistory = async (placement: Placement, older = false) => {
    setHistoryLoading(true);
    setHistoryError(null);
    if (!older) { setHistoryId(placement.id); setHistory([]); }
    try {
      const next = await fetchPlacementEvents(placement.client_id, placement.id, older ? history.length : 0);
      setHistory((current) => older ? [...current, ...next] : next);
      setHasOlder(next.length === 50);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "Could not load placement history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  if (!loading && placements.length === 0) {
    return (
      <EmptyState label="No placements yet — send an approved proof artifact to a destination from Proof Artifacts" />
    );
  }

  return (
    <div className="space-y-4">
    <DataTable
      columns={["Proof and rights", "Destination", "Exact payload", "Status", "What is stopping it", "External record", "Removal record", "Trail", "Actions"]}
      emptyLabel={loading ? "Loading placements…" : "No placements yet"}
      rows={placements.map((placement) => {
        const blocker = due.get(placement.id)?.blocker ?? null;
        const mode = modeOf(placement.destination_key);
        return [
          <span key="p">
            {titleOf(placement.source_proof_id)}
            <span className="block text-xs text-muted-foreground">
              Rights: {proofOf(placement.source_proof_id)?.usage_rights ?? "unknown"}
              {proofOf(placement.source_proof_id)?.expires_on
                ? ` · expires ${dayOrDash(proofOf(placement.source_proof_id)?.expires_on ?? null)}` : ""}
            </span>
          </span>,
          <span key="d">
            {labelOf(placement.destination_key)}
            <span className="block text-xs capitalize text-muted-foreground">{mode}</span>
          </span>,
          <span key="v" className="font-mono text-xs">
            {placement.payload_hash ? placement.payload_hash.slice(0, 16) : "not recorded"}
            <span className="block text-muted-foreground">
              {placement.artifact_version_id ? `artifact ${placement.artifact_version_id.slice(0, 8)}`
                : placement.bound_revision_id ? `page revision ${placement.bound_revision_id.slice(0, 8)}` : "source proof"}
            </span>
          </span>,
          <span key="s">{placement.status.replace(/_/g, " ")}
            <span className="block text-xs text-muted-foreground">{placement.attempts} attempt{placement.attempts === 1 ? "" : "s"}</span>
          </span>,
          <span key="b" className={blocker || placement.last_error ? "text-destructive" : "text-brand-strong"}>
            {/* A failed or rejected placement is outside the due view, so its
                blocker is null while the thing a person needs to read sits in
                last_error. Showing "Nothing" there said the opposite of the
                truth. */}
            {blocker ??
              (placement.status === "uncertain"
                ? placement.last_error ?? "Provider outcome unknown. Inspect the destination before another attempt."
                : placement.status === "failed" && placement.last_error
                  ? placement.last_error
                : LIVE_STATUSES.has(placement.status)
                  ? "Live"
                  : "Nothing")}
          </span>,
          <span key="w" className="text-xs">
            {placement.external_url ? (
              <a href={placement.external_url} target="_blank" rel="noreferrer" className="hover:underline">
                {placement.external_url}
              </a>
            ) : (
              "No external URL"
            )}
            {placement.external_id && <span className="block break-all">ID: {placement.external_id}</span>}
            <span className="block text-muted-foreground">Placed {dayOrDash(placement.placed_at)} · verified {dayOrDash(placement.verified_at)}</span>
          </span>,
          <span key="r" className="text-xs">
            {placement.status === "retracted"
              ? retractionReceipts.has(placement.id)
                ? <>
                    {retractionReceipts.get(placement.id)?.legacy_audit
                      ? "Confirmed later by a person" : "Removal confirmation recorded"}
                    {" · "}{dayOrDash(retractionReceipts.get(placement.id)?.recorded_at ?? null)}
                    {retractionReceipts.get(placement.id)?.evidence_ref && (
                      <span className="block break-all text-muted-foreground">
                        {retractionReceipts.get(placement.id)?.evidence_ref}
                      </span>
                    )}
                  </>
                : <span className="text-destructive">Historical removal unverified</span>
              : "—"}
          </span>,
          <button key="h" type="button" onClick={() => void loadHistory(placement)}
            className="text-xs text-brand-strong underline">View history</button>,
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
                      label: "Review in Approval Inbox",
                      onSelect: () => navigate(`/clients/${placement.client_id}/delivery/approval-inbox?tab=unified`),
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
                    label: LIVE_STATUSES.has(placement.status) || placement.placed_at || placement.external_id || placement.external_url
                      ? "Confirm removal" : "Cancel unplaced proof",
                    destructive: true,
                    onSelect: () => confirmProofRemoval(placement, onAct),
                  }]
                : []),
              ...(placement.status === "retracted" && !retractionReceipts.has(placement.id)
                ? [{
                    label: "Audit historical removal",
                    onSelect: () => auditLegacyProofRemoval(placement, onAct),
                  }]
                : []),
            ]}
          />,
        ];
      })}
    />
    {historyId && (
      <section className="space-y-2 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Placement history · {titleOf(placements.find((p) => p.id === historyId)?.source_proof_id ?? "")}</h3>
        {historyError && <p role="alert" className="text-sm text-destructive">{historyError}</p>}
        <DataTable columns={["When", "Event", "Actor", "Result / evidence"]}
          emptyLabel={historyLoading ? "Loading events…" : "No events recorded"}
          rows={history.map((event) => [
            <span key="w">{dayOrDash(event.occurred_at)}</span>,
            <span key="e">{event.event.replace(/_/g, " ")}</span>,
            <span key="a">{event.actor}</span>,
            <span key="d" className="text-xs">{event.detail ?? "—"}
              {event.external_ref && <span className="block break-all">{event.external_ref}</span>}
            </span>,
          ])} />
        {hasOlder && <button type="button" disabled={historyLoading}
          onClick={() => { const placement = placements.find((p) => p.id === historyId); if (placement) void loadHistory(placement, true); }}
          className="text-xs text-brand-strong underline">Load older events</button>}
      </section>
    )}
    </div>
  );
}

function RightsTab({
  placements, retractionReceipts, due, proof, titleOf, busy, loading, onAct,
}: {
  placements: Placement[];
  retractionReceipts: ReadonlyMap<string, RetractionReceipt>;
  due: ReadonlyMap<string, PlacementDue>;
  proof: ProofAsset[];
  titleOf: (id: string) => string;
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const needsRetraction = placements.filter((p) => p.status === "retraction_required");
  const unverifiedLegacy = placements.filter((p) => p.status === "retracted" && !retractionReceipts.has(p.id));
  const live = placements.filter((p) => LIVE_STATUSES.has(p.status));
  const bySource = new Map<string, Placement[]>();
  for (const placement of live) {
    bySource.set(placement.source_proof_id, [...(bySource.get(placement.source_proof_id) ?? []), placement]);
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <SurfaceCoverage />

      {/* Then, because it is the only part of this screen that is a job
          rather than a record. Permission ending while something is live is
          the case the whole table exists for. */}
      <section className="space-y-2">
        <h3 className="font-semibold">Needs taking down</h3>
        {needsRetraction.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {unverifiedLegacy.length > 0
              ? "No current removal demand. Historical removals below still need verification."
              : "No current removal demand. Every recorded live placement rests on proof that is still cleared."}
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
                  label: LIVE_STATUSES.has(placement.status) || placement.placed_at || placement.external_id || placement.external_url
                    ? "Confirm removal" : "Cancel unplaced proof",
                  destructive: true,
                  onSelect: () => confirmProofRemoval(placement, onAct),
                }]}
              />,
            ])}
          />
        )}
      </section>

      {unverifiedLegacy.length > 0 && (
        <section className="space-y-2" aria-label="Historical removal audit">
          <h3 className="font-semibold">Historical removals without confirmation</h3>
          <p className="text-sm text-muted-foreground">
            These placements were marked retracted before removal receipts were required. Their external state is unknown until checked.
          </p>
          <DataTable
            columns={["Proof", "Destination", "Recorded removal", "Actions"]}
            emptyLabel=""
            rows={unverifiedLegacy.map((placement) => [
              <span key="p">{titleOf(placement.source_proof_id)}</span>,
              <span key="d">{due.get(placement.id)?.destination_label ?? placement.destination_key}</span>,
              <span key="t">{dayOrDash(placement.retracted_at)}</span>,
              <ActionMenu key="a" name={titleOf(placement.source_proof_id)} busy={busy === placement.id}
                items={[{ label: "Audit historical removal",
                  onSelect: () => auditLegacyProofRemoval(placement, onAct) }]} />,
            ])}
          />
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold">What is live, and on whose permission</h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : bySource.size === 0 ? (
          <p className="text-sm text-muted-foreground">
            {unverifiedLegacy.length > 0
              ? "No placement is currently recorded as live. Historical external state may still be unknown."
              : "Nothing is placed anywhere yet."}
          </p>
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


/**
 * Where this client's proof actually is — G09 and G10.
 *
 * The rest of this tab reads placements. This reads proof, and asks the
 * reverse question: for each piece of proof, which surfaces is it live on.
 * Until migration 246 that could only be answered for destinations with an
 * adapter, so a proof-derived reel on Instagram and a case study on the
 * client's own site — the two most likely places — were invisible.
 *
 * Leads with the rows that are a problem, because this screen is read on one
 * day: when somebody withdraws their permission.
 */
function SurfaceCoverage() {
  const { clientId } = useParams<{ clientId: string }>();
  const [coverage, setCoverage] = useState<ProofSurfaceCoverage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    let live = true;
    void fetchProofSurfaceCoverage(clientId)
      .then((rows) => {
        if (live) {
          setCoverage(rows);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "Could not load coverage.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const problems = coverage.filter((row) => row.problem);
  const placed = coverage.filter((row) => (row.live_placements ?? 0) > 0);

  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Where this proof actually is</h3>
      <p className="text-xs text-muted-foreground">
        Per piece of proof rather than per placement, across every surface — including the
        client&rsquo;s own site and their social posts, which nothing could see before. This is the
        table to read the day somebody withdraws permission.
      </p>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {problems.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {problems.length} piece(s) of proof need attention.
        </p>
      )}

      <DataTable
        columns={["Proof", "Rights", "Present or removal pending", "Bound, not published", "Problem"]}
        emptyLabel={loading ? "Loading…" : "No proof has reached a surface yet"}
        rows={coverage.map((row) => [
          <span key="p">
            {row.title ?? "Untitled"}
            {row.proof_type && (
              <span className="block text-xs text-muted-foreground">{row.proof_type}</span>
            )}
          </span>,
          <span
            key="r"
            className={row.usage_rights === "approved" ? "text-xs" : "text-xs text-destructive"}
          >
            {row.usage_rights}
            {row.expires_on && (
              <span className="block text-muted-foreground">expires {dayOrDash(row.expires_on)}</span>
            )}
          </span>,
          <span key="l" className="text-xs">
            {(row.live_on ?? []).length > 0 ? (row.live_on ?? []).join(", ") : "nowhere"}
          </span>,
          <span key="b" className="font-mono text-xs tabular-nums">
            {row.bound_not_published ?? 0}
          </span>,
          <span key="x" className={row.problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {row.problem ?? "—"}
          </span>,
        ])}
      />

      {!loading && coverage.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {placed.length} of {coverage.length} piece(s) of proof are recorded on a surface without confirmed removal.
        </p>
      )}
    </section>
  );
}
