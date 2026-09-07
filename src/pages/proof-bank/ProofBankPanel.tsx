import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { Button } from "../../components/Button";
import { FilterPills } from "../../components/FilterPills";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard } from "../../components/MediaCard";
import { AddProofModal } from "../../components/proof/AddProofModal";
import { ProofDetailModal } from "../../components/proof/ProofDetailModal";
import { cn } from "../../lib/cn";
import { ConfirmModal } from "../../components/forms/FormModal";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { enqueueAgentJob } from "../../lib/supabase";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { fetchProofAssets, shortDate, signPaths } from "../../lib/media";
import type { ProofAsset } from "../../lib/media";

export function ProofBankPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [addOpen, setAddOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  // The search takes minutes and files rows when it lands, so the page has to
  // reload itself rather than wait to be reloaded.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const cleared = proof.filter((p) => p.usage_rights === "approved").length;
  const unstructured = proof.filter((p) => !p.claim).length;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}

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
        <div className="flex shrink-0 gap-2">
          <Button icon={Search} onClick={() => setFindOpen(true)}>
            Find Proof Online
          </Button>
          <Button icon={Plus} onClick={() => setAddOpen(true)}>
            Add Proof
          </Button>
        </div>
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

      <ConfirmModal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        title="Find proof online"
        body="Searches the web for proof this business has already published — reviews and ratings, directory listings, press, awards, registrations, case studies on their own site. Each find is filed with the URL it came from so you can check it. Nothing is cleared for use: finding a review is not permission to advertise with it, so everything lands awaiting your decision. Takes a few minutes and costs roughly $0.40."
        confirmLabel="Search"
        onConfirm={async () => {
          if (!clientId) throw new Error("No client selected.");
          await enqueueAgentJob({ agentKey: "proof_discovery", clientId });
          setNotice("Searching. Anything found appears here awaiting clearance.");
        }}
        onDone={refresh}
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
