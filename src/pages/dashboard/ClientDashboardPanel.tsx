import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Rocket } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { ConfirmModal } from "../../components/forms/FormModal";
import { RunAgentModal } from "../../components/agents/RunAgentModal";
import { supabase } from "../../lib/supabase";
import { MasterAIChatDialog } from "../../components/masterai/MasterAIChatDialog";
import { ClientSwitchPanel } from "../../components/switches/ClientSwitchPanel";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { totalSpend, unresolvedFailures } from "../../lib/jobHistory";
import { ClientOperationalBrief } from "./ClientOperationalBrief";
import { DailyPackageSetupPanel } from "./DailyPackageSetupPanel";

type JobRow = {
  id: string;
  agent_key: string;
  input_id: string | null;
  status: string;
  attempts: number;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

const JOB_COLUMNS = "id, agent_key, input_id, status, attempts, cost_usd, error, created_at, completed_at";
// PostgREST caps a response at 1000 rows, so the history is read in pages.
const JOB_PAGE = 1000;

export async function loadJobHistory(clientId: string): Promise<JobRow[]> {
  const all: JobRow[] = [];
  for (let from = 0; ; from += JOB_PAGE) {
    const { data, error } = await supabase
      .from("agent_jobs")
      .select(JOB_COLUMNS)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + JOB_PAGE - 1);
    if (error) throw new Error(`Agent job history could not be loaded: ${error.message}`);
    if (!data) throw new Error("Agent job history returned no rows or error; totals are unknown.");
    all.push(...(data as JobRow[]));
    if (data.length < JOB_PAGE) break;
  }
  return all;
}

export function ClientDashboardPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [history, setHistory] = useState<{
    clientId: string; jobs: JobRow[]; error: string | null;
  } | null>(null);
  const historyRequest = useRef(0);
  const [runOpen, setRunOpen] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const request = ++historyRequest.current;
    try {
      const rows = await loadJobHistory(clientId);
      if (request === historyRequest.current) setHistory({ clientId, jobs: rows, error: null });
    } catch (cause) {
      if (request === historyRequest.current) setHistory({ clientId, jobs: [], error: cause instanceof Error
        ? cause.message : "Agent job history could not be loaded." });
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime-driven, with a poll fallback when a job settles.
  const { inFlight: active, recentFailures, loaded: liveLoaded, error: liveError } = useAgentJobs(clientId, refresh);
  const currentHistory = history?.clientId === clientId ? history : null;
  const jobs = currentHistory?.jobs ?? [];
  const historyError = currentHistory?.error ?? null;

  // All derived from the client's full job history: a busy client runs
  // hundreds of creative and brief jobs, and a recent-jobs window would
  // drop completed strategy agents, undercount spend and keep reporting
  // failures that a later run already fixed.
  const spend = totalSpend(jobs);
  const failed = unresolvedFailures(jobs);

  if (!currentHistory) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      {historyError && <p role="alert" className="text-sm text-destructive">{historyError} Spend and failure totals are unknown. <button type="button" className="underline" onClick={() => void refresh()}>Retry</button></p>}
      {liveError && <p role="alert" className="text-sm text-destructive">Live agent status is unknown: {liveError}</p>}
      {liveLoaded && !liveError && <AgentActivityBar inFlight={active} failures={recentFailures} />}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {clientId && <MasterAIChatDialog scope={{ kind: "client", clientId }} />}
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

      {clientId && <ClientOperationalBrief key={clientId} clientId={clientId}
        spend={historyError ? null : spend}
        failedRuns={historyError ? null : failed.length}
        activeRuns={!liveLoaded || liveError ? null : active.length} />}
      {clientId && <ClientSwitchPanel clientId={clientId} />}
      {clientId && <DailyPackageSetupPanel clientId={clientId} />}

      <Panel title="Agent spend"><p className="text-2xl font-semibold text-card-foreground">
        {historyError ? "Unknown" : `$${spend.toFixed(2)}`}
      </p></Panel>

      {!historyError && failed.length > 0 && (
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
