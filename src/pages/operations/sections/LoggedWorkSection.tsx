import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { DataTable } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { supabase } from "../../../lib/supabase";

type Log = {
  id: string;
  work_done: string;
  logged_on: string;
  minutes: number | null;
  clients: { name: string } | null;
};

/** What an SMM logged, written from their own console. */
export function LoggedWorkSection() {
  const { memberId } = useParams<{ memberId: string }>();
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!memberId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("work_logs")
      .select("id, work_done, logged_on, minutes, clients(name)")
      .eq("member_id", memberId)
      .order("logged_on", { ascending: false });
    setLogs((data ?? []) as unknown as Log[]);
    setLoading(false);
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalMinutes = logs.reduce((sum, l) => sum + (l.minutes ?? 0), 0);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (loading) return <p className="text-sm text-muted-foreground">Loading logged work…</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Entries">
          <p className="text-2xl font-semibold text-card-foreground">{logs.length}</p>
        </Panel>
        <Panel title="Time Logged">
          <p className="text-2xl font-semibold text-card-foreground">
            {totalMinutes === 0 ? "—" : `${hours}h ${minutes}m`}
          </p>
        </Panel>
      </div>

      <DataTable
        columns={["Work Done", "Client", "Date", "Time Taken"]}
        emptyLabel="No work logged yet"
        rows={logs.map((l) => [
          l.work_done,
          l.clients?.name ?? "—",
          l.logged_on,
          l.minutes ? `${l.minutes} min` : "—",
        ])}
      />
    </div>
  );
}
