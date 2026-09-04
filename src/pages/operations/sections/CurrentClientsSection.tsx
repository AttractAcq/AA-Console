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
  due_date: string | null;
  compensation: number | null;
  clients: { name: string } | null;
};

export function CurrentClientsSection() {
  const [assignOpen, setAssignOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [rows, setRows] = useState<Row[]>([]);
  const clientOptions = useOptions(loadClients, assignOpen);

  const refresh = useCallback(async () => {
    if (!memberId) return;
    const { data } = await supabase
      .from("client_assignments")
      .select("id, due_date, compensation, clients(name)")
      .eq("member_id", memberId)
      .is("ended_at", null);
    setRows((data ?? []) as unknown as Row[]);
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "client_id", label: "Client", kind: "select", required: true, options: clientOptions },
    { name: "due_date", label: "Due date", kind: "date" },
    { name: "compensation", label: "Compensation", kind: "number" },
  ];

  return (
    <div>
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
          columns={["Current Clients", "Due Date", "Compensation"]}
          emptyLabel="No clients assigned yet"
          rows={rows.map((r) => [r.clients?.name ?? "—", r.due_date ?? "—", r.compensation ?? "—"])}
        />
      </div>

      <FormModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Assign Client"
        draftKey={`assign-client:${memberId}`}
        fields={fields}
        submitLabel="Assign"
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
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
