import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Rocket } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { ConfirmModal } from "../../components/forms/FormModal";
import { RunAgentModal } from "../../components/agents/RunAgentModal";
import { supabase } from "../../lib/supabase";
import { MasterAIChat } from "../../components/masterai/MasterAIChat";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { cn } from "../../lib/cn";

type JobRow = {
  id: string;
  agent_key: string;
  status: string;
  attempts: number;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type Counts = {
  records: number;
  ideas: number;
  briefs: number;
  media: number;
  proof: number;
};

const STATUS_TONE: Record<string, string> = {
  completed: "bg-primary/10 text-brand-strong",
  running: "bg-primary/10 text-brand-strong",
  claimed: "bg-secondary text-secondary-foreground",
  queued: "bg-secondary text-secondary-foreground",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-secondary text-secondary-foreground",
};

const RUN_ORDER = [
  "icp",
  "competitor",
  "campaign_intel",
  "association",
  "offer_strategy",
  "brand_strategy",
  "money_model",
  "ideation",
];

export function ClientDashboardPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [counts, setCounts] = useState<Counts>({
    records: 0,
    ideas: 0,
    briefs: 0,
    media: 0,
    proof: 0,
  });
  const [runOpen, setRunOpen] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const head = { count: "exact" as const, head: true };
    const [jobRes, records, ideas, briefs, media, proof] = await Promise.all([
      supabase
        .from("agent_jobs")
        .select("id, agent_key, status, attempts, cost_usd, error, created_at, completed_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(40),
      supabase.from("client_agent_records").select("id", head).eq("client_id", clientId),
      supabase.from("client_ideas").select("id", head).eq("client_id", clientId),
      supabase.from("client_briefs").select("id", head).eq("client_id", clientId),
      supabase.from("client_media_assets").select("id", head).eq("client_id", clientId),
      supabase.from("client_proof_assets").select("id", head).eq("client_id", clientId),
    ]);
    setJobs((jobRes.data ?? []) as JobRow[]);
    setCounts({
      records: records.count ?? 0,
      ideas: ideas.count ?? 0,
      briefs: briefs.count ?? 0,
      media: media.count ?? 0,
      proof: proof.count ?? 0,
    });
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime-driven, with a poll fallback, and it reloads the counts as
  // soon as a job settles.
  const { inFlight: active, recentFailures } = useAgentJobs(clientId, refresh);

  const spend = jobs.reduce((sum, j) => sum + Number(j.cost_usd ?? 0), 0);
  const failed = jobs.filter((j) => j.status === "failed");

  // Latest job per agent, so the pipeline reads as current state rather
  // than as history.
  const latestByAgent = new Map<string, JobRow>();
  for (const job of jobs) if (!latestByAgent.has(job.agent_key)) latestByAgent.set(job.agent_key, job);

  const stats = [
    { id: "records", label: "Intelligence records", value: counts.records },
    { id: "ideas", label: "Ideas", value: counts.ideas },
    { id: "briefs", label: "Briefs", value: counts.briefs },
    { id: "media", label: "Media assets", value: counts.media },
    { id: "proof", label: "Proof on file", value: counts.proof },
    { id: "spend", label: "Agent spend", value: `$${spend.toFixed(2)}` },
  ];

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <AgentActivityBar inFlight={active} failures={recentFailures} />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button icon={Play} onClick={() => setRunOpen(true)}>
          Run Agent
        </Button>
        <Button icon={Rocket} onClick={() => setMasterOpen(true)}>
          Run All Agents
        </Button>
      </div>

      {notice && (
        <p role="status" className="text-sm text-brand-strong">
          {notice}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Panel key={s.id} title={s.label}>
            <p className="text-2xl font-semibold text-card-foreground">{s.value}</p>
          </Panel>
        ))}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Pipeline</h2>
          {active.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {active.length} in flight — refreshing automatically
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {RUN_ORDER.map((key) => {
            const job = latestByAgent.get(key);
            const status = job?.status ?? "not run";
            return (
              <div key={key} className="rounded-lg border border-border bg-card p-3.5">
                <p className="text-sm font-medium capitalize text-card-foreground">
                  {key.replace(/_/g, " ")}
                </p>
                <span
                  className={cn(
                    "mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                    STATUS_TONE[status] ?? "bg-muted text-muted-foreground",
                  )}
                >
                  {status}
                </span>
                {job?.status === "failed" && job.error && (
                  <p className="mt-2 line-clamp-2 text-xs text-destructive">{job.error}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {failed.length > 0 && (
        <Panel title={`${failed.length} failed run${failed.length === 1 ? "" : "s"}`}>
          <ul className="space-y-2 text-sm">
            {failed.slice(0, 5).map((job) => (
              <li key={job.id}>
                <span className="font-medium text-foreground">{job.agent_key}</span>
                <span className="text-muted-foreground"> — {job.error}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {clientId && <MasterAIChat scope={{ kind: "client", clientId }} />}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Recent runs</h2>
        <DataTable
          columns={["Agent", "Status", "Attempts", "Cost", "Finished"]}
          emptyLabel="No agent has run for this client yet"
          rows={jobs.slice(0, 12).map((j) => [
            j.agent_key,
            j.status,
            String(j.attempts),
            j.cost_usd ? `$${Number(j.cost_usd).toFixed(3)}` : "—",
            j.completed_at ? new Date(j.completed_at).toLocaleString() : "—",
          ])}
        />
      </div>

      <RunAgentModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        clientId={clientId}
        onQueued={() => {
          setNotice("Queued. The worker picks it up within a few seconds.");
          void refresh();
        }}
      />

      <ConfirmModal
        open={masterOpen}
        onClose={() => setMasterOpen(false)}
        title="Run all agents"
        body="Queues this client's intelligence and strategy agents at once. They run in dependency order — each one waits until the agents it depends on have finished, so nothing has to be sequenced by hand. Anything already queued or running is skipped, as are the agents that act on a specific brief, render or page, which a master run has nothing to hand them. This costs roughly $3 in model usage."
        confirmLabel="Queue all"
        onConfirm={async () => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("start_master_run", { p_client_id: clientId });
          if (error) throw new Error(error.message);
          setNotice("All agents queued. They will run in dependency order.");
        }}
        onDone={refresh}
      />
    </div>
  );
}
