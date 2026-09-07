import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { FilterPills } from "../../components/FilterPills";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard } from "../../components/MediaCard";
import { AddProofModal } from "../../components/proof/AddProofModal";
import { ProofDetailModal } from "../../components/proof/ProofDetailModal";
import { cn } from "../../lib/cn";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { fetchProofAssets, shortDate, signPaths } from "../../lib/media";
import type { ProofAsset } from "../../lib/media";

export function ProofBankPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [addOpen, setAddOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [proof, setProof] = useState<ProofAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const rows = await fetchProofAssets(clientId, activeFilter);
    setProof(rows);
    setUrls(
      await signPaths(
        "proof",
        rows.map((r) => r.storage_path).filter((p): p is string => Boolean(p)),
      ),
    );
    setLoading(false);
  }, [clientId, activeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const cleared = proof.filter((p) => p.usage_rights === "approved").length;
  const unstructured = proof.filter((p) => !p.claim).length;

  return (
    <div>
      {/* Readiness first. The count that matters is not how much proof exists
          but how much an agent may actually cite, and the difference between
          those two numbers is a job somebody can go and do. */}
      {!loading && proof.length > 0 && (
        <div
          className={cn(
            "mb-4 rounded-lg border px-4 py-3 text-sm",
            cleared === proof.length
              ? "border-border bg-card text-muted-foreground"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {cleared === proof.length ? (
            <>All {proof.length} cleared for use.</>
          ) : (
            <>
              <span className="font-medium">
                {cleared} of {proof.length} cleared for use.
              </span>{" "}
              The rest are not offered to any agent — a brief will correctly say there is no proof
              to cite until someone clears them.
            </>
          )}
          {unstructured > 0 && (
            <>
              {" "}
              {unstructured} {unstructured === 1 ? "has" : "have"} no claim recorded, so{" "}
              {unstructured === 1 ? "it cannot" : "they cannot"} be matched to a buyer.
            </>
          )}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Proof
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading proof…</p>
      ) : proof.length === 0 ? (
        <EmptyState label={`No ${activeLabel.toLowerCase()} proof yet`} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {proof.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setOpenId(item.id)}
              className="rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MediaCard
                mediaType={item.media_type}
                url={item.storage_path ? urls.get(item.storage_path) : undefined}
                body={item.claim ?? item.body}
                title={item.title ?? "Untitled"}
                meta={[
                  item.ref_number,
                  item.usage_rights === "approved"
                    ? `cleared · ${item.strength}`
                    : item.usage_rights === "restricted"
                      ? "restricted"
                      : "not cleared",
                  item.avatar_relevance ?? undefined,
                  shortDate(item.created_at),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            </button>
          ))}
        </div>
      )}

      <ProofDetailModal
        proof={proof.find((p) => p.id === openId) ?? null}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        onSaved={refresh}
      />

      <AddProofModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        clientId={clientId}
        onSaved={refresh}
      />
    </div>
  );
}
