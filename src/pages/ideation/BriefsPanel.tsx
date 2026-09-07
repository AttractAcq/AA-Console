import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { cn } from "../../lib/cn";

type Brief = {
  id: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  brief_ref: string | null;
  status: string;
  source_idea_id: string | null;
  created_at: string;
};

const STATUS_TONE: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  approved: "bg-secondary text-secondary-foreground",
  in_production: "bg-primary/10 text-brand-strong",
  complete: "bg-primary/10 text-brand-strong",
  rejected: "bg-destructive/10 text-destructive",
};

export function BriefsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState<Brief | null>(null);
  const [viewing, setViewing] = useState<Brief | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("client_briefs")
      .select(
        "id, title, body, media_type, brief_ref, status, source_idea_id, created_at, hook, premise, argument, proof, script, visual_direction, shot_requirements, b_roll, call_to_action, channel_intent, production_method, proof_asset_id",
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    setBriefs((data ?? []) as Brief[]);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A brief appears minutes after the click that asked for it, so the page
  // has to reload itself when the job finishes rather than waiting to be
  // reloaded by hand.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const shown = briefs.filter((b) => b.media_type === activeFilter);
  const elsewhere = briefs.length - shown.length;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>
      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}

      <DataTable
        columns={["Brief", "Type", "Status", ""]}
        emptyLabel={
          loading
            ? "Loading briefs…"
            : elsewhere > 0
              // "No image briefs" while three video briefs sit one pill away
              // reads as "nothing worked". Say where they actually are.
              ? `No ${activeLabel.toLowerCase()} briefs — ${elsewhere} brief${elsewhere === 1 ? "" : "s"} under another type`
              : "No briefs yet — approve an idea on the Generation tab"
        }
        rows={shown.map((b) => [
          <button
            key="t"
            type="button"
            onClick={() => setViewing(b)}
            className="rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {b.title}
            {b.brief_ref && <span className="block text-xs text-muted-foreground">{b.brief_ref}</span>}
          </button>,
          <span key="m" className="capitalize">{b.media_type}</span>,
          <span
            key="s"
            className={cn(
              "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATUS_TONE[b.status] ?? "bg-muted text-muted-foreground",
            )}
          >
            {b.status.replace(/_/g, " ")}
          </span>,
          // A brief already in production or finished has been actioned;
          // offering Build again would quietly queue a second one.
          b.status === "in_production" || b.status === "complete" ? (
            <span key="a" className="text-xs text-muted-foreground">Actioned</span>
          ) : (
            <button
              key="a"
              type="button"
              onClick={() => setBuilding(b)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Approve &amp; Build
            </button>
          ),
        ])}
      />

      <BriefDetailModal brief={viewing} open={viewing !== null} onClose={() => setViewing(null)} />

      <ApproveAndBuildModal
        brief={building}
        open={building !== null}
        onClose={() => setBuilding(null)}
        onDone={() => {
          setNotice(
            "Queued. Generated assets appear under Media; anything sent to a person is on their dashboard now.",
          );
          void refresh();
        }}
      />
    </div>
  );
}
