import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { IndexDetail, type IndexColumn } from "../../components/index-detail/IndexDetail";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";
import { ServiceOffersPanel } from "./ServiceOffersPanel";

type Offer = Database["public"]["Tables"]["service_offers"]["Row"];
type Version = Database["public"]["Tables"]["service_offer_versions"]["Row"];
type Signoff = Database["public"]["Tables"]["service_offer_signoffs"]["Row"];
type Drift = Database["public"]["Views"]["offer_version_drift"]["Row"];
type Opportunity = Pick<Database["public"]["Tables"]["market_opportunities"]["Row"], "id" | "name" | "micro_market">;
type SecondarySource = Database["public"]["Tables"]["secondary_offer_sources_v7"]["Row"];
type MainSource = Database["public"]["Tables"]["main_offer_sources_v7"]["Row"];

/** Offers lists existing versions and live-use drift. Build starts from a
 * internal baseline strategy or an approved opportunity, then uses the same
 * version and approval records for manual and agent-generated drafts. */
export function OfferStudioPanel({ view = "offers" }: { view?: "offers" | "build" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [approvedOpportunities, setApprovedOpportunities] = useState<Opportunity[]>([]);
  const [sources, setSources] = useState<SecondarySource[]>([]);
  const [mainSources, setMainSources] = useState<MainSource[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState("");
  const [buildSource, setBuildSource] = useState<"baseline" | "opportunity" | null>(null);
  const [serviceName, setServiceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCompiles, setPendingCompiles] = useState<Array<{ id: string; kind: "main" | "secondary" }>>([]);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [offerResult, versionResult, signoffResult, driftResult, opportunityResult, approvalResult, sourceResult, mainSourceResult] = await Promise.all([
      supabase.from("service_offers").select("*").eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase.from("service_offer_versions").select("*").eq("client_id", clientId)
        .order("version", { ascending: false }),
      supabase.from("service_offer_signoffs").select("*").eq("client_id", clientId),
      supabase.from("offer_version_drift").select("*").eq("client_id", clientId),
      supabase.from("market_opportunities").select("id,name,micro_market").eq("client_id", clientId),
      supabase.from("opportunity_approval_state_v6").select("opportunity_id,approval_current").eq("client_id", clientId),
      supabase.from("secondary_offer_sources_v7").select("*").eq("client_id", clientId),
      supabase.from("main_offer_sources_v7").select("*").eq("client_id", clientId),
    ]);
    setLoading(false);
    const queryError =
      offerResult.error ?? versionResult.error ?? signoffResult.error ?? driftResult.error
      ?? opportunityResult.error ?? approvalResult.error ?? sourceResult.error ?? mainSourceResult.error;
    if (queryError) {
      setReadError(queryError.message);
      return;
    }
    setReadError(null);
    setOffers(offerResult.data ?? []);
    setVersions(versionResult.data ?? []);
    setSignoffs(signoffResult.data ?? []);
    setDrift(driftResult.data ?? []);
    const allOpportunities = opportunityResult.data ?? [];
    setOpportunities(allOpportunities);
    const currentIds = new Set((approvalResult.data ?? []).filter((row) => row.approval_current).map((row) => row.opportunity_id));
    const current = allOpportunities.filter((row) => currentIds.has(row.id));
    setApprovedOpportunities(current);
    setSources(sourceResult.data ?? []);
    setMainSources(mainSourceResult.data ?? []);
    setSelectedOpportunity((previous) => current.some((row) => row.id === previous) ? previous : (current[0]?.id ?? ""));
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (pendingCompiles.length === 0) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const { data, error: jobError } = await supabase.from("agent_jobs")
          .select("id,status,terminal,error")
          .in("id", pendingCompiles.map((job) => job.id));
        if (!active) return;
        if (jobError) {
          setError(`Could not check the compiler: ${jobError.message}`);
          return;
        }
        const finished = (data ?? []).filter((job) =>
          job.status === "completed" || (job.status === "failed" && job.terminal));
        if (finished.length === 0) return;
        const completed = finished.filter((job) => job.status === "completed");
        const failed = finished.filter((job) => job.status === "failed");
        if (completed.length > 0) await refresh();
        if (!active) return;
        if (completed.length > 0) setNotice(`${completed.length} offer compile ${completed.length === 1 ? "finished" : "jobs finished"}. Review the draft version before signing off.`);
        if (failed.length > 0) setError(failed.map((job) => `Offer compile failed: ${job.error ?? "No reason was recorded."}`).join(" "));
        setPendingCompiles((current) => current.filter((job) => !finished.some((done) => done.id === job.id)));
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [pendingCompiles, refresh]);

  async function create(kind: "main" | "secondary") {
    if (!clientId) return;
    if (!serviceName.trim()) { setError("Name the business service before creating a manual draft."); return; }
    setBusy(kind);
    setError(null);
    const { data: created, error: insertError } = kind === "secondary"
      ? await supabase.rpc("create_named_secondary_offer_v9", {
        p_opportunity_id: selectedOpportunity, p_service_name: serviceName.trim(),
      })
      : await supabase.rpc("create_named_main_offer_v9", {
        p_client_id: clientId, p_service_name: serviceName.trim(),
      });
    setBusy(null);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    await refresh();
    if (created?.id) {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set("tab", "build");
        next.set("offer", created.id);
        return next;
      });
      setNotice("Source-bound offer created. Complete its draft version below, then request exact review.");
    }
  }

  /**
 * Ask the Offer Compiler to draft the chosen service instead of writing it yourself.
   *
   * Main offers use Offer Strategy. Secondary offers use the selected approved
   * opportunity and are bound to its exact evidence version.
   *
   * It drafts a version and stops. Price and claims are left empty on purpose
   * -- a price is a commercial decision and a claim needs proof -- and nothing
   * is live until the version is signed off, which is the gate that already
   * existed.
   */
  async function compile(kind: "main" | "secondary") {
    if (!clientId) return;
    if (!serviceName.trim()) { setError("Name the business service before drafting with the agent."); return; }
    setBusy(`compile-${kind}`);
    setError(null);
    const { data: jobId, error: rpcError } = await supabase.rpc("request_named_offer_compile_v9", {
      p_client_id: clientId,
      p_kind: kind,
      // The SQL function requires an explicit nullable UUID argument; generated
      // RPC types represent that position as a non-null string.
      p_opportunity_id: (kind === "secondary" ? selectedOpportunity : null) as unknown as string,
      p_service_name: serviceName.trim(),
    });
    setBusy(null);
    if (rpcError) {
      // The database explains itself here -- no offer strategy yet, or a
      // compile already running -- so show what it said.
      setError(rpcError.message);
      return;
    }
    await refresh();
    setNotice(`Queued. The compiler is drafting a ${kind} offer from ${kind === "main" ? "Offer Strategy" : "the selected approved opportunity"}.`);
    if (jobId) setPendingCompiles((current) => [...current, { id: jobId, kind }]);
  }

  async function setArchived(offer: Offer, archive: boolean) {
    if (busy) return;
    setBusy(offer.id); setError(null); setNotice(null);
    const { error: rpcError } = await supabase.rpc("set_service_offer_archived_v10", {
      p_offer_id: offer.id, p_archive: archive,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
    setNotice(archive
      ? "Offer archived. Existing versions and campaign references remain readable; no new use is allowed until restoration."
      : "Offer restored for new version and campaign use, subject to current source and approval checks.");
  }

  async function deleteEmptyDraft(offer: Offer) {
    if (busy) return;
    setBusy(offer.id); setError(null); setNotice(null);
    const { error: rpcError } = await supabase.rpc("delete_empty_service_offer_v10", {
      p_offer_id: offer.id,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
    setNotice("Empty draft deleted. Its deletion is recorded; no version or approval history was removed.");
  }

  const versionsFor = (offer: Offer) => versions.filter((version) => version.offer_id === offer.id);
  const signedOff = (versionId: string) =>
    signoffs.some((signoff) => signoff.offer_version_id === versionId);
  /** Superseded and still live is the only row that needs doing something about today. */
  const driftingFor = (offer: Offer) =>
    drift.filter((row) => row.offer_id === offer.id && row.superseded === true && row.live === true);
  const liveUsesFor = (offer: Offer) =>
    drift.filter((row) => row.offer_id === offer.id && row.live === true);

  const latestFor = (offer: Offer) => versionsFor(offer)[0] ?? null;
  const activeOffers = offers.filter((offer) => offer.archived_at === null);
  const archivedOffers = offers.filter((offer) => offer.archived_at !== null);
  const proposedOffers = activeOffers.filter((offer) => {
    const latest = latestFor(offer);
    return !latest || !signedOff(latest.id);
  });
  const approvedOffers = activeOffers.filter((offer) => {
    const latest = latestFor(offer);
    return Boolean(latest && signedOff(latest.id));
  });
  const columns: IndexColumn<Offer>[] = [
    { label: "Service", cell: (offer) => offer.service_name },
    { label: "Status", cell: (offer) => latestFor(offer) ? (signedOff(latestFor(offer)!.id) ? "Signed off" : "Proposed") : "Needs draft" },
    { label: "Opportunity", cell: (offer) => {
      if (offer.kind !== "secondary") return "Baseline service";
      const source = sources.find((row) => row.offer_id === offer.id);
      return source ? opportunities.find((row) => row.id === source.opportunity_id)?.name
        ?? source.opportunity_id : "Source unknown";
    } },
    { label: "Version", cell: (offer) => latestFor(offer) ? `v${latestFor(offer)!.version}` : "No version" },
    { label: "Owner", cell: (offer) => {
      const latest = latestFor(offer);
      return signoffs.find((signoff) => signoff.offer_version_id === latest?.id)?.approved_by ?? "Not recorded";
    } },
    {
      label: "Live elsewhere",
      cell: (offer) => {
        if (offer.archived_at !== null) {
          const live = liveUsesFor(offer);
          return live.length ? `${live.length} recorded live use${live.length === 1 ? " remains" : "s remain"}` : "None recorded";
        }
        const stale = driftingFor(offer);
        if (stale.length === 0) return "—";
        return (
          <span className="text-destructive">
            {stale.length} superseded {stale.length === 1 ? "version" : "versions"} still live
          </span>
        );
      },
    },
  ];

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (readError) {
    return <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>Offers are unavailable: {readError}</p>
      <button type="button" onClick={() => void refresh()}>Retry</button>
    </div>;
  }

  const selectedBuildOffer = activeOffers.find((offer) => offer.id === searchParams.get("offer"));
  const selectedArchivedOffer = archivedOffers.find((offer) => offer.id === searchParams.get("offer"));
  if (view === "build") {
    const kind = buildSource === "opportunity" ? "secondary" : "main";
    return <div className="space-y-4">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <section className="space-y-4 rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold">Build an offer</h2>
        <p className="text-sm text-muted-foreground">Choose the source first. The draft remains proposed until its exact version is approved.</p>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Offer source</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="offer-source" checked={buildSource === "opportunity"}
            onChange={() => setBuildSource("opportunity")} />Approved opportunity</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="offer-source" checked={buildSource === "baseline"}
            onChange={() => setBuildSource("baseline")} />Baseline service</label>
        </fieldset>
        {buildSource === "opportunity" && <label className="block text-sm">Approved opportunity
          <select className="mt-1 block w-full rounded border border-border bg-background px-2 py-1" value={selectedOpportunity}
            onChange={(event) => setSelectedOpportunity(event.target.value)}>
            {approvedOpportunities.length === 0 && <option value="">No currently approved opportunity</option>}
            {approvedOpportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>
              {opportunity.name} — {opportunity.micro_market}</option>)}
          </select>
        </label>}
        {buildSource === "baseline" && <p className="text-sm text-muted-foreground">Uses the current Offer Strategy. The chosen service stays bound to this offer's versions.</p>}
        {buildSource && <label className="block text-sm">Business service
          <input className="mt-1 block w-full rounded border border-border bg-background px-2 py-1"
            maxLength={200} value={serviceName} onChange={(event) => setServiceName(event.target.value)}
            placeholder="Name the service this offer sells" />
        </label>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy !== null || buildSource === null || !serviceName.trim() || (kind === "secondary" && !selectedOpportunity)}
            onClick={() => void create(kind)}>{busy === kind ? "Creating…" : "Create manual draft"}</Button>
          <Button disabled={busy !== null || buildSource === null || !serviceName.trim() || (kind === "secondary" && !selectedOpportunity)}
            onClick={() => void compile(kind)} className="bg-muted text-foreground hover:bg-muted">
            {busy === `compile-${kind}` ? "Queueing…" : "Draft with agent"}</Button>
        </div>
      </section>
      {activeOffers.length > 0 && <label className="block text-sm">Continue an existing offer
        <select className="mt-1 block w-full rounded border border-border bg-background px-2 py-1"
          value={selectedBuildOffer?.id ?? ""}
          onChange={(event) => setSearchParams((current) => {
            const next = new URLSearchParams(current);
            next.set("tab", "build");
            if (event.target.value) next.set("offer", event.target.value);
            else next.delete("offer");
            return next;
          })}>
          <option value="">Choose an existing offer</option>
          {activeOffers.map((offer) => <option key={offer.id} value={offer.id}>
            {offer.service_name} · {offer.kind === "secondary" ? "opportunity" : "baseline"}
          </option>)}
        </select>
      </label>}
      {selectedArchivedOffer && <p role="status" className="text-sm text-muted-foreground">
        This offer is archived. Restore it from Offers before drafting another version.
      </p>}
      {selectedBuildOffer && <ServiceOffersPanel selectedOfferId={selectedBuildOffer.id} />}
    </div>;
  }

  return (
    <div className="space-y-3">
      {notice && (
        <p role="status" className="text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <IndexDetail<Offer>
        title="Proposed offers"
        items={proposedOffers}
        columns={columns}
        paramKey="offer"
        emptyLabel="No proposed offers. Open Build to make a baseline service or approved-opportunity offer."
        nameOf={(offer) => offer.service_name}
        action={<Link to={`/clients/${clientId}/delivery/offer-studio?tab=build`}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Build offer</Link>}
        rowActions={(offer) => <span className="flex flex-wrap gap-3">
          <Link to={`/clients/${clientId}/delivery/offer-studio?tab=build&offer=${offer.id}`}
            className="text-brand-strong underline">Edit</Link>
          <button type="button" disabled={busy !== null} onClick={() => void setArchived(offer,true)}
            className="text-brand-strong underline disabled:opacity-50">Archive</button>
          {versionsFor(offer).length === 0 && <button type="button" disabled={busy !== null}
            onClick={() => void deleteEmptyDraft(offer)} className="text-destructive underline disabled:opacity-50">Delete empty draft</button>}
        </span>}
        detail={(offer) => {
          const all = versionsFor(offer);
          const stale = driftingFor(offer);
          const source = sources.find((row) => row.offer_id === offer.id);
          const mainSource = mainSources.find((row) => row.offer_id === offer.id);
          return (
            <div className="space-y-4 text-sm">
              <p className="text-muted-foreground">
                {offer.kind === "secondary"
                  ? "A secondary offer targets one micro-niche, and is compiled from that market opportunity."
                  : mainSource
                    ? "This main offer is bound to Offer Strategy."
                    : "This legacy main offer has no Offer Strategy snapshot bound."}
              </p>

              {offer.kind === "secondary" && (
                <p className={source ? "text-muted-foreground" : "text-destructive"}>
                  {source ? <>
                    Source opportunity: <Link className="text-brand-strong underline-offset-2 hover:underline"
                      to={`/clients/${clientId}/delivery/market-opportunities?opportunity=${source.opportunity_id}`}>
                      {source.opportunity_id}
                    </Link>. Evidence is frozen at offer creation; changed evidence holds new sign-off.
                  </> : "No approved opportunity source is bound. This offer cannot be signed off until recreated from a current opportunity."}
                </p>
              )}

              {offer.kind === "main" && mainSource && (
                <p className="text-muted-foreground">
                  Source: Offer Strategy snapshot {mainSource.strategy_hash.slice(0, 12)}. Later source edits hold new sign-off and campaign use.
                </p>
              )}
              {offer.kind === "main" && !mainSource && (
                <p className="text-destructive">
                  Source review is unverified for this historical offer. Inspect its evidence before new campaign use.
                </p>
              )}

              {stale.length > 0 && (
                <div>
                  <p className="font-medium text-destructive">Superseded versions still live</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {stale.map((row) => (
                      <li key={`${row.offer_version_id}-${row.record_id}-${row.surface}`}>
                        v{row.version} on {row.surface ?? "an unnamed surface"}
                        {row.label ? ` (${row.label})` : ""}
                        {row.live_note ? ` — ${row.live_note}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="font-medium text-card-foreground">Versions</p>
                {all.length === 0 ? (
                  <p className="text-muted-foreground">
                    No version yet. Add one in Service Offers to give this offer a price, promise
                    and claims.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {all.map((version) => (
                      <li key={version.id}>
                        v{version.version} — {version.price_amount ?? "no price"} {version.currency}
                        {signedOff(version.id) ? ", signed off" : ", awaiting sign-off"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p>
                <Link
                  to={`/clients/${clientId}/delivery/offer-studio?tab=build&offer=${offer.id}`}
                  className="text-brand-strong underline-offset-2 hover:underline"
                >
                  Edit versions and claims
                </Link>
              </p>
            </div>
          );
        }}
      />
      <p className="text-xs text-muted-foreground">
        Approved offers below have a recorded sign-off on their latest version. Current source and proof rights are checked again before campaign use.
      </p>
      <IndexDetail<Offer>
        title="Approved offers"
        items={approvedOffers}
        columns={columns}
        paramKey="offer"
        emptyLabel="No latest offer version has a recorded sign-off."
        nameOf={(offer) => offer.service_name}
        rowActions={(offer) => <span className="flex flex-wrap gap-3">
          <Link to={`/clients/${clientId}/delivery/offer-studio?tab=build&offer=${offer.id}`}
            className="text-brand-strong underline">Revise</Link>
          <button type="button" disabled={busy !== null} onClick={() => void setArchived(offer,true)}
            className="text-brand-strong underline disabled:opacity-50">Archive</button>
        </span>}
        detail={(offer) => <div className="space-y-2 text-sm">
          <p>Signed-off version v{latestFor(offer)?.version}. A later revision needs its own exact approval.</p>
          <p>Source and proof rights are rechecked before new campaign use; a historical sign-off alone does not release a stale source.</p>
          {offer.kind === "secondary" && sources.find((row) => row.offer_id === offer.id) && <p>
            Source opportunity: <Link className="text-brand-strong underline"
              to={`/clients/${clientId}/delivery/market-opportunities?opportunity=${sources.find((row) => row.offer_id === offer.id)?.opportunity_id}`}>
              {opportunities.find((row) => row.id === sources.find((source) => source.offer_id === offer.id)?.opportunity_id)?.name ?? "Open opportunity"}
            </Link>
          </p>}
          {driftingFor(offer).length > 0 && <div>
            <p className="font-medium text-destructive">Superseded versions still live</p>
            <ul className="space-y-1 text-muted-foreground">
              {driftingFor(offer).map((row) => <li key={`${row.offer_version_id}-${row.record_id}-${row.surface}`}>
                v{row.version} on {row.surface ?? "an unnamed surface"}
                {row.label ? ` (${row.label})` : ""}
                {row.live_note ? ` — ${row.live_note}` : ""}
              </li>)}
            </ul>
          </div>}
          <Link to={`/clients/${clientId}/delivery/offer-studio?tab=build&offer=${offer.id}`}
            className="text-brand-strong underline">View versions and linked campaigns</Link>
        </div>}
      />
      <IndexDetail<Offer>
        title="Archived offers"
        items={archivedOffers}
        columns={columns}
        paramKey="offer"
        emptyLabel="No archived offers."
        nameOf={(offer) => offer.service_name}
        rowActions={(offer) => <button type="button" disabled={busy !== null}
          onClick={() => void setArchived(offer,false)}
          className="text-brand-strong underline disabled:opacity-50">Restore</button>}
        detail={(offer) => <div className="space-y-2 text-sm">
          <p>Archived {offer.archived_at}. Existing versions and campaign references remain readable.</p>
          <p>Archive does not retract existing live use. {liveUsesFor(offer).length} recorded live use(s) remain.</p>
          <p>New versions, sign-offs and campaign bindings are held until this offer is restored.</p>
          <p>{versionsFor(offer).length} recorded version(s); {versionsFor(offer).filter((version) => signedOff(version.id)).length} signed off.</p>
          <ul className="space-y-1">
            {versionsFor(offer).map((version) => <li key={version.id}>
              v{version.version} · {signedOff(version.id) ? "Signed off" : "Proposed"} · {version.promise} ·
              <span className="font-mono text-xs"> {version.content_hash.slice(0, 16)}…</span>
            </li>)}
          </ul>
        </div>}
      />
    </div>
  );
}
