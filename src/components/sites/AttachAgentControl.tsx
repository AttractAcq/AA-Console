import { useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import {
  deployableAgents,
  originForPage,
  type ApprovableAgent,
  type PublishablePage,
} from "../../pages/sites/readiness";

/**
 * Attach an approved agent to a published page.
 *
 * Attach is not go-live. Enable/Disable on the Sites panel is the switch that
 * lets the runtime answer; this only writes the deployment row (enabled:
 * false) so a later publish can embed the public_id. Origin is derived from
 * the published URL — typing one is how a widget silently never works.
 */
export function AttachAgentControl({
  clientId,
  page,
  agents,
  attachedAgentIds,
  onAttached,
}: {
  clientId: string;
  page: PublishablePage;
  agents: ApprovableAgent[];
  attachedAgentIds: string[];
  onAttached: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const origin = originForPage(page.published_url);
  const attached = useMemo(() => new Set(attachedAgentIds), [attachedAgentIds]);
  const remaining = useMemo(
    () => agents.filter((agent) => !attached.has(agent.id)),
    [agents, attached],
  );
  const choices = useMemo(() => deployableAgents(remaining, page), [remaining, page]);
  const selected = choices.find((choice) => choice.agent.id === selectedId) ?? null;

  const attachBlocker = (() => {
    if (!origin) return "This page's published URL has no usable origin.";
    return selected?.blocker ?? null;
  })();
  const canAttach = Boolean(origin && selected && !selected.blocker && !busy);

  const attach = async () => {
    if (!canAttach || !selected || !origin) return;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const { error } = await supabase.from("client_sales_agent_deployments").insert({
      client_id: clientId,
      sales_agent_id: selected.agent.id,
      page_id: page.id,
      site_repository_id: page.site_repository_id,
      allowed_origin: origin,
      enabled: false,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    setSelectedId("");
    setNotice(
      "Attached, but switched off. Republish the page to put the widget on it, then Enable it to let it answer visitors.",
    );
    onAttached();
  };

  if (agents.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        No sales agents for this client yet. Build one on the Sales tab first.
      </p>
    );
  }

  if (remaining.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Every sales agent for this client is already attached to this page.
      </p>
    );
  }

  const selectId = `attach-agent-${page.id}`;

  return (
    <div className="mt-3">
      <label htmlFor={selectId} className="mb-1 block text-xs text-muted-foreground">
        Attach a sales agent
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={selectId}
          value={selectedId}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setNotice(null);
            setProblem(null);
          }}
          disabled={busy}
          className="min-w-48 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">Select an agent…</option>
          {choices.map(({ agent, blocker }) => (
            <option key={agent.id} value={agent.id} disabled={blocker !== null}>
              {blocker ? `${agent.name} — ${blocker}` : agent.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!canAttach}
          onClick={() => void attach()}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {busy ? "Attaching…" : "Attach"}
        </button>
      </div>

      {origin && (
        <p className="mt-1 text-xs text-muted-foreground">
          It will answer on {origin}. Enable is a separate step.
        </p>
      )}
      {attachBlocker && <p className="mt-1 text-xs text-muted-foreground">{attachBlocker}</p>}
      {notice && (
        <p role="status" className="mt-1 text-xs text-brand-strong">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
