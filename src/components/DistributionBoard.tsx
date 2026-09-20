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
import { POST_PLATFORMS, platformLabel } from "../lib/postPlatform";
import type { Database } from "../types/database";

type Post = {
  id: string;
  scheduled_for: string;
  ref_number: string | null;
  media_type: MediaFilterId;
  platform: string | null;
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

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
    if (!clientId) return;
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("id, scheduled_for, ref_number, media_type, platform, published_at")
      .eq("client_id", clientId)
      .eq("channel", channel)
      .order("scheduled_for");
    if (error) throw error;
    setPosts((data ?? []) as Post[]);
    } catch (error) {
      setLoadError("Failed to load schedule: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
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
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError("Failed to load approved assets: " + ((error as { message?: string })?.message ?? "Unknown query error"));
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
    {
      name: "platform",
      label: "Platform (optional)",
      kind: "select",
      options: [...POST_PLATFORMS],
      hint: "Where the post lands. A post can be planned before its feed is decided.",
    },
  ];

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

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
          columns={["Date", "Ref Number", "Type", "Platform", "Status"]}
          emptyLabel={`No ${activeLabel.toLowerCase()} assets scheduled`}
          rows={shown.map((p) => [
            p.scheduled_for,
            p.ref_number ?? "—",
            p.media_type,
            platformLabel(p.platform),
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
            // Empty means undecided, which is a real answer. Sending "" would
            // fail the enum; null records that nobody has chosen yet.
            //
            p_platform: (v.platform as string || null) as
              | Database["public"]["Enums"]["post_platform"]
              | null,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
