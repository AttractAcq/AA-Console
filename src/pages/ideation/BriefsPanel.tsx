import { useState } from "react";
import { FilterPills } from "../../components/FilterPills";
import { DataTable } from "../../components/DataTable";
import { mediaFilters } from "../../data/mediaFilters";
import type { MediaFilterId } from "../../data/mediaFilters";

export function BriefsPanel() {
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";

  return (
    <div>
      <div className="mb-4">
        <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
      </div>
      <DataTable
        columns={["Brief", "Type", "Status"]}
        emptyLabel={`No ${activeLabel.toLowerCase()} briefs yet`}
      />
    </div>
  );
}
