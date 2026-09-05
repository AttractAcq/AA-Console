import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";
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

  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";
  const shown = briefs.filter((b) => b.media_type === activeFilter);

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>
      <DataTable
        columns={["Brief", "Type", "Status"]}
        emptyLabel={loading ? "Loading briefs…" : `No ${activeLabel.toLowerCase()} briefs yet`}
        rows={shown.map((b) => [b.title, b.media_type, b.status])}
      />
    </div>
  );
}
