import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";

type Brief = {
  id: string;
  title: string;
  media_type: string;
  status: string;
};

export function BriefsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("client_briefs")
      .select("id, title, media_type, status")
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
      <DataTable
        columns={["Brief", "Type", "Status"]}
        emptyLabel={
          loading
            ? "Loading briefs…"
            : elsewhere > 0
              // "No image briefs" while three video briefs sit one pill away
              // reads as "nothing worked". Say where they actually are.
              ? `No ${activeLabel.toLowerCase()} briefs — ${elsewhere} brief${elsewhere === 1 ? "" : "s"} under another type`
              : "No briefs yet — approve an idea on the Generation tab"
        }
        rows={shown.map((b) => [b.title, b.media_type, b.status])}
      />
    </div>
  );
}
