import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Drift = Database["public"]["Views"]["offer_version_drift"]["Row"];
type ClaimEvidence = Database["public"]["Views"]["offer_claim_evidence"]["Row"];

/**
 * Offer Studio v2 — Live use.
 *
 * v1 versions offers properly, keeps versions immutable and refuses to sign
 * off a quantified claim with no proof behind it. The discipline is real, and
 * it still cannot answer the question somebody asks the day after a reprice:
 * where is the old version still live?
 *
 * Every binding needed to answer it existed and none of them were joined. So
 * a client raises their price, every new asset is correct, and a PDF quoting
 * last year's figure keeps going out to strangers. That is not untidiness; it
 * is the client's credibility, and it gets worse with time rather than
 * better.
 *
 * The expensive row — superseded and live — is sorted to the top and
 * coloured, because it is the only one that needs doing something about
 * today.
 */
export function OfferLiveUsePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [drift, setDrift] = useState<Drift[]>([]);
  const [claims, setClaims] = useState<ClaimEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [usage, evidence] = await Promise.all([
        supabase.from("offer_version_drift").select("*").eq("client_id", clientId),
        supabase.from("offer_claim_evidence").select("*").eq("client_id", clientId),
      ]);
      if (usage.error) throw new Error(usage.error.message);
      if (evidence.error) throw new Error(evidence.error.message);
      setDrift(usage.data ?? []);
      setClaims(evidence.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load offer usage.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Superseded and live first, then superseded, then everything current. */
  const ordered = [...drift].sort((a, b) => {
    const weight = (row: Drift) =>
      row.superseded && row.live === true ? 0 : row.superseded ? 1 : 2;
    return weight(a) - weight(b);
  });
  const urgent = drift.filter((row) => row.superseded && row.live === true).length;
  const problems = claims.filter((claim) => claim.problem !== null);

  if (error && drift.length === 0 && !loading) {
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
        {urgent > 0 ? (
          <p className="text-sm font-medium text-destructive">
            {urgent} live {urgent === 1 ? "surface is" : "surfaces are"} carrying a superseded offer
          </p>
        ) : (
          <p className="text-sm font-medium">Nothing live is carrying a superseded offer</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Current means the newest signed-off version — a draft nobody approved does not make a
          live one wrong. A v6 campaign's own live state is gated elsewhere, so this does not
          claim it.
        </p>
      </div>

      {drift.length === 0 && !loading ? (
        <EmptyState label="No offer version is bound to anything yet" />
      ) : (
        <DataTable
          columns={["Carrying it", "Offer", "Version", "Live", "What is out of date"]}
          emptyLabel={loading ? "Loading…" : "Nothing yet"}
          rows={ordered.map((row) => [
            <span key="s">
              {row.label ?? "Unnamed"}
              <span className="block text-xs text-muted-foreground">
                {row.surface?.replace(/_/g, " ")}
              </span>
            </span>,
            <span key="o">{row.service_name}</span>,
            <span key="v" className={row.superseded ? "text-destructive" : "text-brand-strong"}>
              v{row.version}
              {row.current_version != null && row.superseded && (
                <span className="block text-xs text-muted-foreground">
                  current is v{row.current_version}
                </span>
              )}
            </span>,
            <span key="l" className="text-xs">
              {row.live === true ? (
                <span className="text-brand-strong">yes</span>
              ) : row.live === false ? (
                "no"
              ) : (
                <span className="text-muted-foreground" title={row.live_note ?? undefined}>
                  unknown
                </span>
              )}
            </span>,
            <span
              key="d"
              className={
                row.superseded && row.live === true
                  ? "text-destructive"
                  : row.drift
                    ? "text-amber-600"
                    : "text-brand-strong"
              }
            >
              {row.drift ?? "Current"}
            </span>,
          ])}
        />
      )}

      <section className="space-y-2">
        <h3 className="font-semibold">Claims, and what stands behind them</h3>
        <p className="text-sm text-muted-foreground">
          Sign-off refuses a quantified claim with no proof. Rights expire afterwards without
          asking, and the claim does not know — so this is read now rather than trusted from when
          it was approved.
        </p>
        {problems.length > 0 && (
          <p className="text-sm text-destructive">
            {problems.length} claim{problems.length === 1 ? "" : "s"} no longer{" "}
            {problems.length === 1 ? "has" : "have"} usable proof behind{" "}
            {problems.length === 1 ? "it" : "them"}.
          </p>
        )}
        <DataTable
          columns={["Claim", "Version", "Kind", "Proof", "Problem"]}
          emptyLabel={loading ? "Loading…" : "No claims recorded"}
          rows={claims.map((claim) => [
            <span key="c">{claim.claim_text}</span>,
            <span key="v">v{claim.version}</span>,
            <span key="k" className="text-xs">{claim.kind}</span>,
            <span key="p" className="text-xs">
              {claim.proof_title ?? (claim.kind === "quantified" ? "none" : "—")}
              {claim.expires_on && (
                <span className="block text-muted-foreground">expires {claim.expires_on}</span>
              )}
            </span>,
            <span key="x" className={claim.problem ? "text-destructive" : "text-brand-strong"}>
              {claim.problem ?? "Fine"}
            </span>,
          ])}
        />
      </section>
    </div>
  );
}
