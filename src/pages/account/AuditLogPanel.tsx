import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { loadTeamMembers, useOptions } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Note = {
  id: string;
  note: string;
  noted_on: string;
  team_members: { name: string } | null;
};

export function AuditLogPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [notes, setNotes] = useState<Note[]>([]);
  const memberOptions = useOptions(loadTeamMembers, addOpen);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      if (!clientId) return;
      const { data, error } = await supabase
        .from("client_audit_notes")
        .select("id, note, noted_on, team_members(name)")
        .eq("client_id", clientId)
        .order("noted_on", { ascending: false });
      if (error) throw error;
      setNotes((data ?? []) as unknown as Note[]);
    } catch (error) {
      setLoadError("Failed to load audit notes: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "note", label: "Audit notes", kind: "textarea", rows: 4, required: true },
    { name: "member_id", label: "Member", kind: "select", options: memberOptions },
    { name: "noted_on", label: "Date", kind: "date" },
  ];

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Audit
        </Button>
      </div>

      <DataTable
        columns={["Member", "Date", "Audit Notes"]}
        emptyLabel="No audit entries yet"
        rows={notes.map((n) => [n.team_members?.name ?? "—", n.noted_on, n.note])}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Audit"
        draftKey={`audit:${clientId}`}
        fields={fields}
        submitLabel="Add entry"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.from("client_audit_notes").insert({
            client_id: clientId,
            note: (v.note as string).trim(),
            member_id: (v.member_id as string) || null,
            noted_on: (v.noted_on as string) || new Date().toISOString().slice(0, 10),
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
