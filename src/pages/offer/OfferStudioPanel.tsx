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
 * reviewed baseline strategy or an approved opportunity, then uses the same
 * version and approval records for manual and agent-generated drafts. */
export function OfferStudioPanel({ view = "offers" }: { view?: "offers" | "build" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [approvedOpportunities, setApprovedOpportunities] = useState<Opportunity[]>([]);
  const [sources, setSources] = useState<SecondarySource[]>([]);
  const [mainSources, setMainSources] = useState<MainSource[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState("");
  const [buildSource, setBuildSource] = useState<"baseline" | "opportunity" | null>(null);
  const [serviceName, setServiceName] = useState("");
  const [loading, setLoading] = useState(true);
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
      setError(queryError.message);
      return;
    }
    setError(null);
    setOffers(offerResult.data ?? []);
    setVersions(versionResult.data ?? []);
    setSignoffs(signoffResult.data ?? []);
    setDrift(driftResult.data ?? []);
    const currentIds = new Set((approvalResult.data ?? []).filter((row) => row.approval_current).map((row) => row.opportunity_id));
    const current = (opportunityResult.data ?? []).filter((row) => currentIds.has(row.id));
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

  const versionsFor = (offer: Offer) => versions.filter((version) => version.offer_id === offer.id);
  const signedOff = (versionId: string) =>
    signoffs.some((signoff) => signoff.offer_version_id === versionId);
  /** Superseded and still live is the only row that needs doing something about today. */
  const driftingFor = (offer: Offer) =>
    drift.filter((row) => row.offer_id === offer.id && row.superseded === true && row.live === true);

  const columns: IndexColumn<Offer>[] = [
    { label: "Offer", cell: (offer) => offer.service_name },
    { label: "Kind", cell: (offer) => (offer.kind === "secondary" ? "Secondary" : "Main") },
    {
      label: "Versions",
      cell: (offer) => {
        const all = versionsFor(offer);
        if (all.length === 0) return "none yet";
        const latest = all[0]!;
        return `v${latest.version}${signedOff(latest.id) ? ", signed off" : ", not signed off"}`;
      },
    },
    {
      label: "Live elsewhere",
      cell: (offer) => {
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

  const selectedBuildOffer = offers.find((offer) => offer.id === searchParams.get("offer"));
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
        {buildSource === "baseline" && <p className="text-sm text-muted-foreground">Uses the current reviewed Offer Strategy. The chosen service stays bound to this offer's versions.</p>}
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
        title="Offers"
        items={offers}
        columns={columns}
        paramKey="offer"
        emptyLabel="No offers yet. Open Build to make a baseline service or approved-opportunity offer."
        nameOf={(offer) => offer.service_name}
        action={<Link to={`/clients/${clientId}/delivery/offer-studio?tab=build`}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Build offer</Link>}
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
                    ? "This main offer is bound to reviewed Offer Strategy."
                    : "This legacy main offer has no reviewed Offer Strategy snapshot bound."}
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
                  Source: reviewed Offer Strategy snapshot {mainSource.strategy_hash.slice(0, 12)}. Later source edits hold new sign-off and campaign use.
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
    </div>
  );
}
