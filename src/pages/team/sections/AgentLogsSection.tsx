import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { DataTable } from "../../../components/DataTable";
import { supabase } from "../../../lib/supabase";
import { cn } from "../../../lib/cn";

type Event = {
  id: string;
  description: string;
  level: string;
  created_at: string;
};

const LEVEL_TONE: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-warn",
  error: "text-destructive",
};

/** Turn-by-turn trail for one agent, newest first. */
export function AgentLogsSection() {
  const { agentId } = useParams<{ agentId: string }>();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setLoading(false);
      return;
    }
    // Events belong to jobs; the job carries the agent_key.
    const { data } = await supabase
      .from("agent_job_events")
      .select("id, description, level, created_at, agent_jobs!inner(agent_key)")
      .eq("agent_jobs.agent_key", agentId)
      .order("created_at", { ascending: false })
      .limit(200);
    setEvents((data ?? []) as unknown as Event[]);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading logs…</p>;

  return (
    <DataTable
      columns={["Description", "Date", "Time"]}
      emptyLabel="No logs yet — this agent has not run"
      rows={events.map((e) => {
        const at = new Date(e.created_at);
        return [
          <span key={e.id} className={cn(LEVEL_TONE[e.level] ?? "text-muted-foreground")}>
            {e.description}
          </span>,
          at.toISOString().slice(0, 10),
          at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        ];
      })}
    />
  );
}
