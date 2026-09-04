import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { AgentCard } from "../../components/AgentCard";
import { EmptyState } from "../../components/EmptyState";
import { RuntimeHealthPanel } from "../../components/RuntimeHealthPanel";
import { FormModal } from "../../components/forms/FormModal";
import { initialsFrom, slugFrom } from "../../components/forms/fields";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import type { Agent } from "../../data/agents";

export function AgentsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("agents")
      .select("agent_key, name, initials, paused")
      .order("name");
    setAgents(
      (data ?? []).map((a) => ({
        id: a.agent_key,
        name: a.name,
        initials: a.initials,
        status: a.paused ? "Idle" : "Active",
      })),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "name", label: "Name", kind: "text", required: true },
    {
      name: "agent_key",
      label: "Key",
      kind: "text",
      hint: "The worker dispatches on this. It cannot change later.",
      derivedFrom: { field: "name", transform: slugFrom },
    },
    {
      name: "initials",
      label: "Initials",
      kind: "text",
      derivedFrom: { field: "name", transform: initialsFrom },
    },
    {
      name: "requires_upstream",
      label: "Requires upstream",
      kind: "text",
      placeholder: "icp, competitor",
      hint: "Comma-separated agent keys that must have completed before this one may run.",
    },
  ];

  return (
    <div>
      <RuntimeHealthPanel />

      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Agent
        </Button>
      </div>

      {agents.length === 0 ? (
        <EmptyState label="No agents registered" />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Agent"
        draftKey={"add-agent"}
        intro="An agent row needs matching worker code to do anything — registering one here only makes it queueable."
        fields={fields}
        submitLabel="Register agent"
        onSubmit={async (v) => {
          const upstream = ((v.requires_upstream as string) || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const { error } = await supabase.from("agents").insert({
            agent_key: ((v.agent_key as string) || slugFrom(v.name as string)).trim(),
            name: (v.name as string).trim(),
            initials: ((v.initials as string) || initialsFrom(v.name as string)).trim().toUpperCase(),
            requires_upstream: upstream,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
