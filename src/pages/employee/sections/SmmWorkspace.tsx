import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Users } from "lucide-react";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { supabase } from "../../../lib/supabase";

type AssignedClient = {
  client_id: string;
  due_date: string | null;
  compensation: number | null;
  clients: { name: string; sector: string | null } | null;
};

type WorkLog = {
  id: string;
  work_done: string;
  logged_on: string;
  minutes: number | null;
  client_id: string | null;
};

/** Social Media Managers work per-client and log time against it. */
export function SmmWorkspace({ memberId }: { memberId: string }) {
  const [clients, setClients] = useState<AssignedClient[]>([]);
  const [logs, setLogs] = useState<WorkLog[]>([]);
  const [loading, setLoading] = useState(true);

  const [workDone, setWorkDone] = useState("");
  const [minutes, setMinutes] = useState("");
  const [clientId, setClientId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [assigned, logged] = await Promise.all([
      supabase
        .from("client_assignments")
        .select("client_id, due_date, compensation, clients(name, sector)")
        .eq("member_id", memberId)
        .is("ended_at", null),
      supabase
        .from("work_logs")
        .select("id, work_done, logged_on, minutes, client_id")
        .eq("member_id", memberId)
        .order("logged_on", { ascending: false })
        .limit(20),
    ]);
    setClients((assigned.data ?? []) as unknown as AssignedClient[]);
    setLogs((logged.data ?? []) as WorkLog[]);
    setLoading(false);
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleLog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workDone.trim()) {
      setError("Describe the work you did.");
      return;
    }
    setError(null);
    setSaving(true);
    const { error: insertError } = await supabase.from("work_logs").insert({
      member_id: memberId,
      client_id: clientId || null,
      work_done: workDone.trim(),
      minutes: minutes ? Number(minutes) : null,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setWorkDone("");
    setMinutes("");
    void refresh();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading your clients…</p>;

  return (
    <div className="space-y-6">
      <Panel title="Your clients">
        {clients.length === 0 ? (
          <EmptyState label="No clients assigned to you yet" minHeight={100} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {clients.map((row) => (
              <div
                key={row.client_id}
                className="flex items-start gap-3 rounded-md border border-border p-4"
              >
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {row.clients?.name ?? "Client"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.clients?.sector ?? "—"}
                    {row.due_date ? ` · due ${row.due_date}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Log work">
        <form onSubmit={handleLog} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_140px_160px]">
            <input
              aria-label="What did you do?"
              value={workDone}
              onChange={(e) => setWorkDone(e.target.value)}
              placeholder="What did you do?"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <input
              aria-label="Minutes"
              type="number"
              min="0"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="Minutes"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <select
              aria-label="Client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">No client</option>
              {clients.map((row) => (
                <option key={row.client_id} value={row.client_id}>
                  {row.clients?.name ?? row.client_id}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {saving ? "Saving…" : "Log work"}
          </button>
        </form>
      </Panel>

      <Panel title="Logged work">
        <DataTable
          columns={["Work Done", "Date", "Time Taken"]}
          emptyLabel="Nothing logged yet"
          rows={logs.map((log) => [
            log.work_done,
            log.logged_on,
            log.minutes ? `${log.minutes} min` : "—",
          ])}
        />
      </Panel>
    </div>
  );
}
