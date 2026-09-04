import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CalendarPlus } from "lucide-react";
import { Button } from "./Button";
import { MonthCalendar } from "./MonthCalendar";
import type { ScheduledAsset } from "./MonthCalendar";
import { FilterPills } from "./FilterPills";
import { DataTable } from "./DataTable";
import { FormModal } from "./forms/FormModal";
import type { FieldDef } from "./forms/fields";
import { mediaFilters } from "../data/mediaFilters";
import type { MediaFilterId } from "../data/mediaFilters";
import { fetchClientAssets } from "../lib/media";
import { supabase } from "../lib/supabase";

type Post = {
  id: string;
  scheduled_for: string;
  ref_number: string | null;
  media_type: MediaFilterId;
  published_at: string | null;
};

/**
 * Organic and Paid are the same board on a different channel. Only
 * approved assets appear in the picker — schedule_asset() enforces it
 * server-side too.
 */
export function DistributionBoard({ channel }: { channel: "organic" | "paid" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [activeFilter, setActiveFilter] = useState<MediaFilterId>(mediaFilters[0].id);
  const [posts, setPosts] = useState<Post[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [assetOptions, setAssetOptions] = useState<Array<{ value: string; label: string }>>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("scheduled_posts")
      .select("id, scheduled_for, ref_number, media_type, published_at")
      .eq("client_id", clientId)
      .eq("channel", channel)
      .order("scheduled_for");
    setPosts((data ?? []) as Post[]);
  }, [clientId, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Approved-only, and only for this client.
  useEffect(() => {
    if (!scheduleOpen || !clientId) return;
    let cancelled = false;
    void fetchClientAssets(clientId, { reviewStatus: "approved" }).then((rows) => {
      if (cancelled) return;
      setAssetOptions(
        rows.map((r) => ({
          value: r.id,
          label: `${r.ref_number ?? "—"} · ${r.title ?? "Untitled"}`,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [scheduleOpen, clientId]);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const calendarAssets: ScheduledAsset[] = posts
    .filter((p) => p.scheduled_for.startsWith(thisMonth))
    .map((p) => ({ day: Number(p.scheduled_for.slice(8, 10)), refNumber: p.ref_number ?? "—" }));

  const shown = posts.filter((p) => p.media_type === activeFilter);
  const activeLabel = mediaFilters.find((f) => f.id === activeFilter)?.label ?? "";

  const fields: FieldDef[] = [
    {
      name: "asset_id",
      label: "Asset",
      kind: "select",
      required: true,
      options: assetOptions,
      hint: "Only approved assets can be scheduled.",
    },
    { name: "scheduled_for", label: "Date", kind: "date", required: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={CalendarPlus} onClick={() => setScheduleOpen(true)}>
          Schedule {channel === "paid" ? "Paid" : "Organic"}
        </Button>
      </div>

      <MonthCalendar assets={calendarAssets} />

      <div>
        <div className="mb-4">
          <FilterPills options={mediaFilters} activeId={activeFilter} onChange={setActiveFilter} />
        </div>
        <DataTable
          columns={["Date", "Ref Number", "Type", "Status"]}
          emptyLabel={`No ${activeLabel.toLowerCase()} assets scheduled`}
          rows={shown.map((p) => [
            p.scheduled_for,
            p.ref_number ?? "—",
            p.media_type,
            p.published_at ? "Published" : "Scheduled",
          ])}
        />
      </div>

      <FormModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title={`Schedule ${channel === "paid" ? "paid" : "organic"} asset`}
        draftKey={`schedule:${channel}:${clientId}`}
        fields={fields}
        submitLabel="Schedule"
        onSubmit={async (v) => {
          const { error } = await supabase.rpc("schedule_asset", {
            p_asset_id: v.asset_id as string,
            p_date: v.scheduled_for as string,
            p_channel: channel,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
