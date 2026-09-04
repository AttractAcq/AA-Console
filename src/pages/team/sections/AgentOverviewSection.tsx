import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Panel } from "../../../components/Panel";
import { supabase } from "../../../lib/supabase";

type Stats = {
  runs: number;
  failed_runs: number;
  failure_rate: number;
  total_cost: number;
  avg_monthly_cost: number;
};

/** Every figure here is an aggregate over agent_jobs — none is stored. */
export function AgentOverviewSection() {
  const { agentId } = useParams<{ agentId: string }>();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void supabase
      .from("agent_stats")
      .select("runs, failed_runs, failure_rate, total_cost, avg_monthly_cost")
      .eq("agent_key", agentId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setStats((data as Stats) ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading agent stats…</p>;

  const money = (v: number | null | undefined) => `$${Number(v ?? 0).toFixed(2)}`;
  const cards = [
    { id: "total-cost", label: "Total Cost", value: money(stats?.total_cost) },
    { id: "avg-cost", label: "Average Monthly Cost", value: money(stats?.avg_monthly_cost) },
    { id: "runs", label: "Runs", value: String(stats?.runs ?? 0) },
    { id: "failed", label: "Failed Runs", value: String(stats?.failed_runs ?? 0) },
    {
      id: "rate",
      label: "Failure Rate",
      value: `${(Number(stats?.failure_rate ?? 0) * 100).toFixed(1)}%`,
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((c) => (
        <Panel key={c.id} title={c.label}>
          <p className="text-2xl font-semibold text-card-foreground">{c.value}</p>
        </Panel>
      ))}
    </div>
  );
}
