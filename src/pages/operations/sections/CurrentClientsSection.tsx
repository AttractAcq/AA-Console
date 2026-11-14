import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { FormModal } from "../../../components/forms/FormModal";
import type { FieldDef } from "../../../components/forms/fields";
import { loadClients, useOptions } from "../../../lib/options";
import { supabase } from "../../../lib/supabase";

type Row = {
  id: string;
  client_id: string;
  due_date: string | null;
  compensation: number | null;
  clients: { name: string } | null;
};

export function CurrentClientsSection() {
  const [assignOpen, setAssignOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [authoritySeat, setAuthoritySeat] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const clientOptions = useOptions(loadClients, assignOpen);

  const refresh = useCallback(async () => {
    if (!memberId) return;
    setLoadError(null);
    try {
      const member = await supabase.from("team_members").select("category").eq("id", memberId).single();
      if (member.error) throw member.error;
      setAuthoritySeat(member.data.category === "smm" || member.data.category === "creative_director");
      const { data, error } = await supabase
        .from("client_assignments")
        .select("id, client_id, due_date, compensation, clients(name)")
        .eq("member_id", memberId)
        .is("ended_at", null);
      if (error) throw error;
      setRows((data ?? []) as unknown as Row[]);
    } catch (error) {
      setLoadError("Failed to load current clients: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "client_id", label: "Client", kind: "select", required: true, options: clientOptions },
    { name: "due_date", label: "Due date", kind: "date" },
    { name: "compensation", label: "Compensation", kind: "number" },
  ];

  async function requestEnd(row: Row) {
    if (!memberId) return;
    setActionError(null);
    setActionMessage(null);
    setBusyId(row.id);
    try {
      const { error } = await supabase.rpc("request_client_authority_assignment_v6", {
        p_member_id: memberId, p_client_id: row.client_id, p_action: "end",
      });
      if (error) throw error;
      setActionMessage(`Ending ${row.clients?.name ?? "this client"} is pending in the Approval Inbox.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      {actionError && <p role="alert" className="mb-3 text-sm text-red-600">{actionError}</p>}
      {actionMessage && <p role="status" className="mb-3 text-sm">{actionMessage}</p>}
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAssignOpen(true)}>
          Assign Client
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Client Count">
            <p className="text-2xl font-semibold text-card-foreground">{rows.length}</p>
          </Panel>
          <Panel title="Due Date">
            <p className="text-2xl font-semibold text-card-foreground">
              {rows.find((r) => r.due_date)?.due_date ?? "—"}
            </p>
          </Panel>
        </div>
        <DataTable
          columns={authoritySeat ? ["Current Clients", "Due Date", "Compensation", "Approval seat"] : ["Current Clients", "Due Date", "Compensation"]}
          emptyLabel="No clients assigned yet"
          rows={rows.map((r) => [r.clients?.name ?? "—", r.due_date ?? "—", r.compensation ?? "—",
            ...(authoritySeat ? [<button key={r.id} type="button" disabled={busyId === r.id}
              onClick={() => void requestEnd(r)}>Request end</button>] : [])])}
        />
      </div>

      <FormModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Assign Client"
        draftKey={`assign-client:${memberId}`}
        fields={fields}
        submitLabel={authoritySeat ? "Request assignment" : "Assign"}
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          setActionMessage(null);
          if (authoritySeat) {
            const { error } = await supabase.rpc("request_client_authority_assignment_v6", {
              p_member_id: memberId,
              p_client_id: v.client_id as string,
              p_action: "assign",
              p_due_date: (v.due_date as string) || undefined,
              p_compensation: v.compensation ? Number(v.compensation) : undefined,
            });
            if (error) throw error;
            setActionMessage("The client approval seat is pending in the Approval Inbox.");
            return;
          }
          const { error } = await supabase.from("client_assignments").insert({
            member_id: memberId,
            client_id: v.client_id as string,
            due_date: (v.due_date as string) || null,
            compensation: v.compensation ? Number(v.compensation) : null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
