import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { IndexDetail, type IndexColumn } from "../../components/index-detail/IndexDetail";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Offer = Database["public"]["Tables"]["service_offers"]["Row"];
type Version = Database["public"]["Tables"]["service_offer_versions"]["Row"];
type Signoff = Database["public"]["Tables"]["service_offer_signoffs"]["Row"];
type Drift = Database["public"]["Views"]["offer_version_drift"]["Row"];
type Opportunity = Pick<Database["public"]["Tables"]["market_opportunities"]["Row"], "id" | "name" | "micro_market">;
type SecondarySource = Database["public"]["Tables"]["secondary_offer_sources_v7"]["Row"];
type MainSource = Database["public"]["Tables"]["main_offer_sources_v7"]["Row"];

/**
 * Offer Studio, as one page.
 *
 * The notes: "There should just be a single page, where we can see all of the
 * offers, and then two buttons, one to create a main offer and one to create a
 * secondary offer ... The page should display all offers in a simple table
 * format with the ability to click on the offer to see more information as well
 * as actions to archive, edit, etc."
 *
 * Three tabs became one table. It uses the shared index-and-detail pattern, so
 * this page looks and behaves like Website Studio, Lead Magnet Studio, Sales OS
 * and Market Opportunities will.
 *
 * WHAT THE TWO BUTTONS WRITE
 *
 * A main offer is the business's own, compiled from offer strategy. A secondary
 * offer targets one micro-niche, compiled from that market opportunity. Nothing
 * in the schema distinguished them until migration 303, so the buttons had
 * nothing to say; they now set `kind`.
 *
 * WHAT STAYED
 *
 * The old Live use tab existed to answer one question: where is a superseded
 * version still live? That is a real question -- a client reprices, every new
 * asset is correct, and a PDF quoting last year's figure keeps going out -- so
 * it is not dropped. It moves into the row, where a drifting offer is named on
 * the offer it belongs to rather than in a separate list, and into the detail
 * for the specifics.
 *
 * The version form still lives in Service Offers, linked from the detail. The
 * compile agent the notes ask for -- one that assembles an offer from strategy
 * or from a micro-niche -- is runtime work and is not here yet, so for now the
 * inputs remain manual, which is what the notes call the suggested path anyway.
 */
export function OfferStudioPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [approvedOpportunities, setApprovedOpportunities] = useState<Opportunity[]>([]);
  const [sources, setSources] = useState<SecondarySource[]>([]);
  const [mainSources, setMainSources] = useState<MainSource[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState("");
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
    setBusy(kind);
    setError(null);
    const { error: insertError } = kind === "secondary"
      ? await supabase.rpc("create_secondary_offer_v7", { p_opportunity_id: selectedOpportunity })
      : await supabase.rpc("create_main_offer_v7", { p_client_id: clientId });
    setBusy(null);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    await refresh();
  }

  /**
   * Ask the Offer Compiler for one instead of writing it yourself.
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
    setBusy(`compile-${kind}`);
    setError(null);
    const { data: jobId, error: rpcError } = await supabase.rpc("request_offer_compile_v6", {
      p_client_id: clientId,
      p_kind: kind,
      p_source: kind === "main" ? "strategy" : "micro_niche",
      p_opportunity_id: kind === "secondary" ? selectedOpportunity : undefined,
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
        emptyLabel="No offers yet. Create a main offer for the business, or a secondary one for a micro-niche."
        nameOf={(offer) => offer.service_name}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor="secondary-offer-opportunity">Secondary offer opportunity</label>
            <select id="secondary-offer-opportunity" className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={selectedOpportunity} onChange={(event) => setSelectedOpportunity(event.target.value)}>
              {approvedOpportunities.length === 0 && <option value="">No currently approved opportunity</option>}
              {approvedOpportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.name} — {opportunity.micro_market}</option>)}
            </select>
            <Button disabled={busy !== null} onClick={() => void create("main")}>
              {busy === "main" ? "…" : "New main offer"}
            </Button>
            {/* Button is one style by design, so the secondary action is
                distinguished with className rather than by widening a
                component used across the console. */}
            <Button
              disabled={busy !== null || !selectedOpportunity}
              onClick={() => void create("secondary")}
              className="bg-muted text-foreground hover:bg-muted"
            >
              {busy === "secondary" ? "…" : "New secondary offer"}
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => void compile("main")}
              className="bg-muted text-foreground hover:bg-muted"
            >
              {busy === "compile-main" ? "…" : "Compile a main offer"}
            </Button>
            <Button
              disabled={busy !== null || !selectedOpportunity}
              onClick={() => void compile("secondary")}
              className="bg-muted text-foreground hover:bg-muted"
            >
              {busy === "compile-secondary" ? "…" : "Compile a secondary offer"}
            </Button>
          </div>
        }
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
                  : "A main offer is the business's own, and is compiled from offer strategy."}
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
                  to={`/clients/${clientId}/delivery/offer-studio?tab=versions&offer=${offer.id}`}
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
