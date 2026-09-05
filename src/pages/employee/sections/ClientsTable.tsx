import { useCallback, useEffect, useState } from "react";
import { DataTable } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { supabase } from "../../../lib/supabase";

type Assignment = {
  id: string;
  client_id: string;
  due_date: string | null;
  compensation: number | null;
  ended_at: string | null;
  created_at: string;
  clients: { name: string; sector: string | null } | null;
};

type WorkLog = { client_id: string | null; minutes: number | null; logged_on: string };

/**
 * An SMM's client roster, split on whether the assignment has ended.
 *
 * The dashboard already lists current clients as names; this exists to
 * answer the question that list cannot — how much work has actually gone
 * into each one. Without that, "current clients" is just a repeat.
 */
export function ClientsTable({
  memberId,
  scope,
}: {
  memberId: string;
  scope: "current" | "past";
}) {
  const [rows, setRows] = useState<Assignment[]>([]);
  const [logs, setLogs] = useState<WorkLog[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    let query = supabase
      .from("client_assignments")
      .select("id, client_id, due_date, compensation, ended_at, created_at, clients(name, sector)")
      .eq("member_id", memberId);

    query =
      scope === "current"
        ? query.is("ended_at", null).order("due_date", { nullsFirst: false })
        : query.not("ended_at", "is", null).order("ended_at", { ascending: false });

    const [assignments, workLogs] = await Promise.all([
      query,
      supabase.from("work_logs").select("client_id, minutes, logged_on").eq("member_id", memberId),
    ]);

    setRows((assignments.data ?? []) as unknown as Assignment[]);
    setLogs((workLogs.data ?? []) as WorkLog[]);
    setLoading(false);
  }, [memberId, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const statsFor = (clientId: string) => {
    const mine = logs.filter((l) => l.client_id === clientId);
    const minutes = mine.reduce((sum, l) => sum + (l.minutes ?? 0), 0);
    const last = mine.map((l) => l.logged_on).sort().at(-1) ?? null;
    return { entries: mine.length, minutes, last };
  };

  const time = (minutes: number) =>
    minutes === 0 ? "—" : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  // The time is already the total across the entries, so "2 × 2h 15m" would
  // read as twice that. Separate the count from the total.
  const workload = (entries: number, minutes: number) =>
    `${entries} ${entries === 1 ? "entry" : "entries"} · ${time(minutes)}`;

  const totalMinutes = rows.reduce((sum, r) => sum + statsFor(r.client_id).minutes, 0);

  const columns =
    scope === "current"
      ? ["Client", "Sector", "Due Date", "Work logged", "Last activity", "Compensation"]
      : ["Client", "Sector", "Ended", "Work logged", "Compensation"];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={scope === "current" ? "Current clients" : "Past clients"}>
          <p className="text-2xl font-semibold text-card-foreground">{rows.length}</p>
        </Panel>
        <Panel title="Time logged across them">
          <p className="text-2xl font-semibold text-card-foreground">{time(totalMinutes)}</p>
        </Panel>
      </div>

      <DataTable
        columns={columns}
        emptyLabel={
          scope === "current"
            ? "No clients assigned to you"
            : "No past clients — none of your assignments have ended"
        }
        rows={rows.map((r) => {
          const s = statsFor(r.client_id);
          const money = r.compensation === null ? "—" : Number(r.compensation).toFixed(2);
          // A former assignment intentionally loses access to the client's
          // data; only identity survives, so a missing name here means the
          // client row itself was removed.
          const name = r.clients?.name ?? "(no longer available)";
          return scope === "current"
            ? [
                name,
                r.clients?.sector ?? "—",
                r.due_date ?? "—",
                s.entries === 0 ? "None yet" : workload(s.entries, s.minutes),
                s.last ?? "—",
                money,
              ]
            : [
                name,
                r.clients?.sector ?? "—",
                r.ended_at?.slice(0, 10) ?? "—",
                s.entries === 0 ? "None" : workload(s.entries, s.minutes),
                money,
              ];
        })}
      />
    </div>
  );
}
