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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [offerResult, versionResult, signoffResult, driftResult] = await Promise.all([
      supabase.from("service_offers").select("*").eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase.from("service_offer_versions").select("*").eq("client_id", clientId)
        .order("version", { ascending: false }),
      supabase.from("service_offer_signoffs").select("*").eq("client_id", clientId),
      supabase.from("offer_version_drift").select("*").eq("client_id", clientId),
    ]);
    setLoading(false);
    const queryError =
      offerResult.error ?? versionResult.error ?? signoffResult.error ?? driftResult.error;
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setError(null);
    setOffers(offerResult.data ?? []);
    setVersions(versionResult.data ?? []);
    setSignoffs(signoffResult.data ?? []);
    setDrift(driftResult.data ?? []);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(kind: "main" | "secondary") {
    if (!clientId) return;
    setBusy(kind);
    setError(null);
    const { error: insertError } = await supabase.from("service_offers").insert({
      client_id: clientId,
      kind,
      // Named on creation so the row is identifiable in the table before
      // anybody has filled in a version. Renaming is part of editing.
      service_name: kind === "main" ? "New main offer" : "New secondary offer",
    });
    setBusy(null);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    await refresh();
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
          <div className="flex gap-2">
            <Button disabled={busy !== null} onClick={() => void create("main")}>
              {busy === "main" ? "…" : "New main offer"}
            </Button>
            {/* Button is one style by design, so the secondary action is
                distinguished with className rather than by widening a
                component used across the console. */}
            <Button
              disabled={busy !== null}
              onClick={() => void create("secondary")}
              className="bg-muted text-foreground hover:bg-muted"
            >
              {busy === "secondary" ? "…" : "New secondary offer"}
            </Button>
          </div>
        }
        detail={(offer) => {
          const all = versionsFor(offer);
          const stale = driftingFor(offer);
          return (
            <div className="space-y-4 text-sm">
              <p className="text-muted-foreground">
                {offer.kind === "secondary"
                  ? "A secondary offer targets one micro-niche, and is compiled from that market opportunity."
                  : "A main offer is the business's own, and is compiled from offer strategy."}
              </p>

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
