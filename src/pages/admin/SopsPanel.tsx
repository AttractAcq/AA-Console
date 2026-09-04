import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import { titleFromFile } from "../../components/forms/fields";
import type { FieldDef } from "../../components/forms/fields";
import { loadTeamMembers, uploadThen, useOptions } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Sop = {
  id: string;
  title: string;
  updated_at: string;
  team_members: { name: string } | null;
};

export function SopsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const [sops, setSops] = useState<Sop[]>([]);
  const ownerOptions = useOptions(loadTeamMembers, addOpen);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("sops")
      .select("id, title, updated_at, team_members(name)")
      .order("updated_at", { ascending: false });
    setSops((data ?? []) as unknown as Sop[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "file", label: "File", kind: "file", required: true, accept: ".pdf,.doc,.docx,.md,.txt" },
    {
      name: "title",
      label: "Title",
      kind: "text",
      derivedFrom: { field: "file", transform: (v) => v },
    },
    { name: "owner_id", label: "Owner", kind: "select", options: ownerOptions },
  ];

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add SOP
        </Button>
      </div>

      <DataTable
        columns={["SOP", "Owner", "Last Updated"]}
        emptyLabel="No SOPs added yet"
        rows={sops.map((s) => [
          s.title,
          s.team_members?.name ?? "—",
          new Date(s.updated_at).toISOString().slice(0, 10),
        ])}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add SOP"
        draftKey={"add-sop"}
        fields={fields}
        submitLabel="Upload"
        onSubmit={async (v) => {
          const file = v.file as File;
          const sopId = crypto.randomUUID();
          const path = `${sopId}/${file.name}`;
          await uploadThen("sops", path, file, async (storagePath) => {
            const { error } = await supabase.from("sops").insert({
              id: sopId,
              title: ((v.title as string) || titleFromFile(file)).trim(),
              owner_id: (v.owner_id as string) || null,
              storage_path: storagePath,
            });
            if (error) throw error;
          });
        }}
        onSaved={refresh}
      />
    </div>
  );
}
