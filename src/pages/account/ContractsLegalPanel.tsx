import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { FileAssetCard } from "../../components/FileAssetCard";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import { titleFromFile } from "../../components/forms/fields";
import type { FieldDef } from "../../components/forms/fields";
import { uploadThen } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Contract = { id: string; title: string; created_at: string };

const FIELDS: FieldDef[] = [
  { name: "file", label: "File", kind: "file", required: true, accept: ".pdf,.doc,.docx" },
  {
    name: "title",
    label: "Title",
    kind: "text",
    derivedFrom: { field: "file", transform: (v) => v },
  },
  { name: "signed_at", label: "Signed on", kind: "date" },
];

export function ContractsLegalPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [contracts, setContracts] = useState<Contract[]>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_contracts")
      .select("id, title, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    setContracts((data ?? []) as Contract[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Contract
        </Button>
      </div>

      {contracts.length === 0 ? (
        <EmptyState label="No contracts uploaded yet" />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {contracts.map((c) => (
            <FileAssetCard
              key={c.id}
              label={c.title}
              meta={new Date(c.created_at).toISOString().slice(0, 10)}
            />
          ))}
        </div>
      )}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Contract"
        draftKey={`contract:${clientId}`}
        fields={FIELDS}
        submitLabel="Upload"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const file = v.file as File;
          const contractId = crypto.randomUUID();
          const path = `${clientId}/${contractId}/${file.name}`;
          await uploadThen("contracts", path, file, async (storagePath) => {
            const { error } = await supabase.from("client_contracts").insert({
              id: contractId,
              client_id: clientId,
              title: ((v.title as string) || titleFromFile(file)).trim(),
              storage_path: storagePath,
              signed_at: (v.signed_at as string) || null,
            });
            if (error) throw error;
          });
        }}
        onSaved={refresh}
      />
    </div>
  );
}
