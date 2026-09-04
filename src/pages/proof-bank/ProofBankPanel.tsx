import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { FilterPills } from "../../components/FilterPills";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard } from "../../components/MediaCard";
import { AddProofModal } from "../../components/proof/AddProofModal";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { fetchProofAssets, shortDate, signPaths } from "../../lib/media";
import type { ProofAsset } from "../../lib/media";

export function ProofBankPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [addOpen, setAddOpen] = useState(false);
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

  return (
    <div>
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
            <MediaCard
              key={item.id}
              mediaType={item.media_type}
              url={item.storage_path ? urls.get(item.storage_path) : undefined}
              body={item.body}
              title={item.title ?? "Untitled"}
              meta={[item.source, shortDate(item.created_at)].filter(Boolean).join(" · ")}
            />
          ))}
        </div>
      )}

      <AddProofModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        clientId={clientId}
        onSaved={refresh}
      />
    </div>
  );
}
