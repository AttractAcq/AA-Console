import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { ACCESS_LEVEL_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";

type Integration = {
  id: string;
  provider: string;
  credential_label: string | null;
  access_level: string | null;
  status: string;
};

const FIELDS: FieldDef[] = [
  {
    name: "provider",
    label: "Provider",
    kind: "select",
    required: true,
    options: [
      { value: "meta", label: "Meta" },
      { value: "instagram", label: "Instagram" },
      { value: "facebook", label: "Facebook" },
      { value: "resend", label: "Resend" },
      { value: "google", label: "Google" },
      { value: "other", label: "Other" },
    ],
  },
  { name: "credential_label", label: "Label", kind: "text", placeholder: "Which key this is" },
  {
    name: "secret",
    label: "Credential",
    kind: "password",
    required: true,
    hint: "Stored in Supabase Vault. Never written to a table and never shown again.",
  },
  { name: "access_level", label: "Access level", kind: "select", options: ACCESS_LEVEL_OPTIONS },
];

export function IntegrationsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<Integration[]>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_integrations")
      .select("id, provider, credential_label, access_level, status")
      .eq("client_id", clientId)
      .order("provider");
    setRows((data ?? []) as Integration[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add
        </Button>
      </div>

      <DataTable
        columns={["Integration", "Credential", "Access Level"]}
        emptyLabel="No integrations connected yet"
        rows={rows.map((r) => [r.provider, r.credential_label ?? "—", r.access_level ?? "—"])}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Integration"
        draftKey={`integration:${clientId}`}
        fields={FIELDS}
        submitLabel="Connect"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("admin_store_integration_credential", {
            p_client_id: clientId,
            p_provider: v.provider as string,
            p_label: (v.credential_label as string)?.trim() || "default",
            p_secret: v.secret as string,
            p_access_level: (v.access_level as string) || undefined,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
