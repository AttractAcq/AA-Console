import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "../Modal";
import { FieldControl } from "../forms/fields";
import type { FieldDef, FormValues } from "../forms/fields";
import { AGENT_FORMS, submitAgentRun } from "../forms/AgentSteerForm";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type RecordDomain = Database["public"]["Enums"]["record_domain"];

type RunnableAgent = {
  agent_key: string;
  name: string;
  description: string | null;
  requires_upstream: string[];
  paused: boolean;
};

/**
 * Pick an agent, see what that agent actually asks for, then run it.
 *
 * The field list is per-agent, which is why this is not a FormModal: the
 * fields depend on a value inside the form. Agents with no steer inputs
 * (ideation) say so rather than showing an empty box.
 */
export function RunAgentModal({
  open,
  onClose,
  clientId,
  onQueued,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string | undefined;
  onQueued?: () => void;
}) {
  const [agents, setAgents] = useState<RunnableAgent[]>([]);
  const [agentKey, setAgentKey] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentKey("");
    setValues({});
    setError(null);
    setBusy(false);
    void supabase
      .from("agents")
      .select("agent_key, name, description, requires_upstream, paused")
      .is("archived_at", null)
      .order("name")
      .then(({ data }) => setAgents((data ?? []) as RunnableAgent[]));
  }, [open]);

  const agent = agents.find((a) => a.agent_key === agentKey);
  const config = agentKey in AGENT_FORMS ? AGENT_FORMS[agentKey as RecordDomain] : undefined;
  const fields: FieldDef[] = useMemo(() => config?.fields ?? [], [config]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!clientId) {
      setError("No client selected.");
      return;
    }
    if (!agent) {
      setError("Choose an agent first.");
      return;
    }

    const missing = fields.filter(
      (f) => f.required && !(values[f.name] as string | undefined)?.toString().trim(),
    );
    if (missing.length > 0) {
      setError(`${missing.map((f) => f.label).join(", ")} is required.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (config) {
        // Record-producing agents write their steer inputs first, then
        // enqueue against that input row.
        await submitAgentRun(agentKey as RecordDomain, clientId, values);
      } else {
        const { error: rpcError } = await supabase.rpc("enqueue_agent_job", {
          p_agent_key: agent.agent_key,
          p_client_id: clientId,
        });
        // The gate lives in the database, so a refusal here is the real
        // reason rather than something guessed in the browser.
        if (rpcError) throw new Error(rpcError.message);
      }
      setBusy(false);
      onQueued?.();
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not queue the run.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Run an agent">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="agent-select" className="text-sm font-medium text-foreground">
            Agent
          </label>
          <select
            id="agent-select"
            value={agentKey}
            onChange={(e) => {
              setAgentKey(e.target.value);
              setValues({});
              setError(null);
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Select an agent…</option>
            {agents.map((a) => (
              <option key={a.agent_key} value={a.agent_key} disabled={a.paused}>
                {a.name}
                {a.paused ? " (paused)" : ""}
              </option>
            ))}
          </select>
        </div>

        {agent && (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            {agent.description && (
              <p className="text-sm text-muted-foreground">{agent.description}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {agent.requires_upstream.length === 0
                ? "Runs against business context alone."
                : `Needs ${agent.requires_upstream.join(", ")} to have completed for this client first — it will refuse otherwise.`}
            </p>
          </div>
        )}

        {agent && config?.intro && (
          <p className="text-sm text-muted-foreground">{config.intro}</p>
        )}

        {agent &&
          fields.map((field) => (
            <FieldControl
              key={field.name}
              field={field}
              value={values[field.name] ?? (field.kind === "toggle" ? false : "")}
              onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
            />
          ))}

        {agent && !config && (
          <p className="text-sm text-muted-foreground">
            This agent takes no inputs — it reads what has already been generated for this client.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !agent}
            className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? "Queueing…" : "Run agent"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
