import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { MonthCalendar } from "../../components/MonthCalendar";
import type { ScheduledAsset } from "../../components/MonthCalendar";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { CHANNEL_OPTIONS, loadApprovedAssets, useOptions } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Post = {
  id: string;
  scheduled_for: string;
  ref_number: string | null;
  media_type: string;
  channel: string;
};

export function CalendarPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const assetOptions = useOptions(loadApprovedAssets, addOpen);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("scheduled_posts")
        .select("id, scheduled_for, ref_number, media_type, channel")
        .order("scheduled_for");
      if (error) throw error;
      setPosts((data ?? []) as Post[]);
    } catch (error) {
      setLoadError("Failed to load calendar: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "scheduled_for", label: "Date", kind: "date", required: true },
    {
      name: "asset_id",
      label: "Asset",
      kind: "select",
      required: true,
      options: assetOptions,
      hint: "Only approved assets can be scheduled. Reference, media type and client are copied from it.",
    },
    { name: "channel", label: "Channel", kind: "select", options: CHANNEL_OPTIONS },
  ];

  // Only this month's posts land on the grid; the table below is the full list.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const calendarAssets: ScheduledAsset[] = posts
    .filter((p) => p.scheduled_for.startsWith(thisMonth))
    .map((p) => ({ day: Number(p.scheduled_for.slice(8, 10)), refNumber: p.ref_number ?? "—" }));

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Event
        </Button>
      </div>

      <div className="mb-4">
        <MonthCalendar assets={calendarAssets} />
      </div>

      <DataTable
        columns={["Date", "Ref Number", "Type", "Channel"]}
        emptyLabel="Nothing scheduled yet"
        rows={posts.map((p) => [p.scheduled_for, p.ref_number ?? "—", p.media_type, p.channel])}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Event"
        draftKey={"add-event"}
        fields={fields}
        submitLabel="Schedule"
        onSubmit={async (v) => {
          const { error } = await supabase.rpc("schedule_asset", {
            p_asset_id: v.asset_id as string,
            p_date: v.scheduled_for as string,
            p_channel: ((v.channel as string) || "organic") as "organic" | "paid",
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
