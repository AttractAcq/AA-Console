import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Pause, PlayCircle, Settings, Archive, ArchiveRestore } from "lucide-react";
import { ActionCard } from "../../../components/ActionCard";
import { Panel } from "../../../components/Panel";
import { FormModal, ConfirmModal } from "../../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../../components/forms/fields";
import { loadClients, useOptions } from "../../../lib/options";
import { supabase } from "../../../lib/supabase";
import type { Database } from "../../../types/database";
import { cn } from "../../../lib/cn";

type AgentRow = {
  agent_key: string;
  name: string;
  paused: boolean;
  archived_at: string | null;
  domain: string | null;
  description: string | null;
  requires_upstream: string[];
  config: Record<string, unknown>;
};

export function AgentActionsSection() {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [openAction, setOpenAction] = useState<"run" | "pause" | "configure" | "archive" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const clientOptions = useOptions(loadClients, openAction === "run");

  const refresh = useCallback(async () => {
    if (!agentId) return;
    const { data } = await supabase
      .from("agents")
      .select("agent_key, name, paused, archived_at, domain, description, requires_upstream, config")
      .eq("agent_key", agentId)
      .maybeSingle();
    setAgent((data as AgentRow) ?? null);
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function togglePause() {
    if (!agent) return;
    setBusy(true);
    const next = !agent.paused;
    const { error } = await supabase
      .from("agents")
      .update({ paused: next })
      .eq("agent_key", agent.agent_key);
    setBusy(false);
    if (error) {
      setNotice({ kind: "error", text: error.message });
      return;
    }
    // claim_agent_job skips paused agents, so this genuinely stops work
    // rather than only changing a label.
    setNotice({
      kind: "ok",
      text: next
        ? "Paused. Queued jobs stay queued and no worker will claim them."
        : "Resumed. Any queued jobs will be claimed on the next poll.",
    });
    void refresh();
  }

  async function toggleArchive() {
    if (!agent) return;
    const archiving = !agent.archived_at;
    setBusy(true);
    const { error } = await supabase
      .from("agents")
      .update(archiving ? { archived_at: new Date().toISOString(), paused: true } : { archived_at: null })
      .eq("agent_key", agent.agent_key);
    setBusy(false);
    if (error) {
      setNotice({ kind: "error", text: error.message });
      return;
    }
    setNotice({
      kind: "ok",
      text: archiving
        ? "Archived and paused. It's hidden from the default agent list; nothing new will be claimed for it."
        : "Unarchived. It's back in the default agent list, still paused — resume it when ready.",
    });
    void refresh();
  }

  if (!agent) return <p className="text-sm text-muted-foreground">Loading agent…</p>;

  const archived = Boolean(agent.archived_at);

  const runFields: FieldDef[] = [
    {
      name: "client_id",
      label: "Client",
      kind: "select",
      required: true,
      options: clientOptions,
      hint:
        agent.requires_upstream.length > 0
          ? `This agent needs ${agent.requires_upstream.join(", ")} to have completed for the client first. It will refuse otherwise.`
          : undefined,
    },
  ];

  const configFields: FieldDef[] = [
    {
      name: "config",
      label: "Configuration (JSON)",
      kind: "textarea",
      rows: 10,
      required: true,
      hint: "Stored on the agent and passed to the worker. Must be a valid JSON object.",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        {archived ? (
          <ActionCard
            title="Unarchive Agent"
            icon={ArchiveRestore}
            onClick={() => setOpenAction("archive")}
          />
        ) : (
          <>
            <ActionCard title="Run Agent" icon={Play} onClick={() => setOpenAction("run")} />
            <ActionCard
              title={agent.paused ? "Resume Agent" : "Pause Agent"}
              icon={agent.paused ? PlayCircle : Pause}
              onClick={() => setOpenAction("pause")}
            />
            <ActionCard title="Edit Configuration" icon={Settings} onClick={() => setOpenAction("configure")} />
            <ActionCard title="Archive Agent" icon={Archive} onClick={() => setOpenAction("archive")} />
          </>
        )}
      </div>

      {notice && (
        <p
          role="status"
          className={cn(
            "text-sm",
            notice.kind === "ok" ? "text-brand-strong" : "text-destructive",
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="State">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              archived
                ? "bg-muted text-muted-foreground"
                : agent.paused
                  ? "bg-secondary text-secondary-foreground"
                  : "bg-primary/10 text-brand-strong",
            )}
          >
            {archived ? "Archived" : agent.paused ? "Paused" : "Active"}
          </span>
          {agent.description && (
            <p className="mt-3 text-sm text-muted-foreground">{agent.description}</p>
          )}
        </Panel>

        <Panel title="Requires upstream">
          {agent.requires_upstream.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing — this agent can run against business context alone.
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {agent.requires_upstream.map((key) => (
                <li key={key}>
                  <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{key}</code> must
                  have completed for the client
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <FormModal
        open={openAction === "run"}
        onClose={() => setOpenAction(null)}
        title={`Run ${agent.name}`}
        intro="Queues a job. The worker claims it within a few seconds; watch progress on the Logs tab."
        fields={runFields}
        submitLabel="Queue run"
        onSubmit={async (v) => {
          const { error } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: agent.agent_key,
            p_client_id: v.client_id as string,
          });
          // The RPC enforces the upstream gate, so a refusal here is the
          // real reason rather than a guess made in the browser.
          if (error) throw new Error(error.message);
          setNotice({ kind: "ok", text: "Queued. The worker will pick it up shortly." });
        }}
      />

      <ConfirmModal
        open={openAction === "pause"}
        onClose={() => setOpenAction(null)}
        title={agent.paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
        body={
          agent.paused
            ? "Workers will start claiming this agent's queued jobs again."
            : "No worker will claim this agent's jobs while it is paused. Anything already running finishes; anything queued waits."
        }
        confirmLabel={agent.paused ? "Resume" : "Pause"}
        onConfirm={togglePause}
        onDone={refresh}
      />

      <FormModal
        open={openAction === "configure"}
        onClose={() => setOpenAction(null)}
        title={`Configure ${agent.name}`}
        fields={configFields}
        initialValues={{ config: JSON.stringify(agent.config ?? {}, null, 2) } as FormValues}
        submitLabel="Save configuration"
        onSubmit={async (v) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(v.config as string);
          } catch {
            throw new Error("That is not valid JSON.");
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("Configuration must be a JSON object, not an array or a bare value.");
          }
          const { error } = await supabase
            .from("agents")
            .update({ config: parsed as Database["public"]["Tables"]["agents"]["Update"]["config"] })
            .eq("agent_key", agent.agent_key);
          if (error) throw error;
          setNotice({ kind: "ok", text: "Configuration saved." });
        }}
        onSaved={refresh}
      />

      <ConfirmModal
        open={openAction === "archive"}
        onClose={() => setOpenAction(null)}
        title={archived ? `Unarchive ${agent.name}` : `Archive ${agent.name}`}
        body={
          archived
            ? "It reappears in the default agent list, still paused. Resume it separately when it's ready for work again."
            : "Hides it from the default agent list and pauses it. Job history is untouched — this doesn't delete anything, and it can be unarchived later."
        }
        confirmLabel={archived ? "Unarchive" : "Archive"}
        onConfirm={toggleArchive}
        onDone={refresh}
      />

      <p className="text-xs text-muted-foreground">
        {busy ? "Working…" : ""}
      </p>
    </div>
  );
}
