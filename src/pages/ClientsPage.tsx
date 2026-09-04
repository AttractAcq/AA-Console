import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/Button";
import { ClientCard } from "../components/ClientCard";
import { EmptyState } from "../components/EmptyState";
import { FormModal } from "../components/forms/FormModal";
import { initialsFrom } from "../components/forms/fields";
import type { FieldDef } from "../components/forms/fields";
import { TIER_OPTIONS } from "../lib/options";
import { supabase } from "../lib/supabase";
import type { Client } from "../data/clients";

const FIELDS: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  {
    name: "initials",
    label: "Initials",
    kind: "text",
    hint: "Prefixes every asset reference this client mints (AA-0001). Settle it now — changing it later orphans old references.",
    derivedFrom: { field: "name", transform: initialsFrom },
  },
  { name: "sector", label: "Sector", kind: "text" },
  { name: "location", label: "Location", kind: "text" },
  { name: "tier", label: "Tier", kind: "select", options: TIER_OPTIONS },
  { name: "is_internal", label: "Internal", kind: "toggle", placeholder: "This is an in-house client" },
];

export function ClientsPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from("clients")
      .select("id, name, initials, sector, location, tier, is_internal")
      .order("name");
    setClients(
      (data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        initials: c.initials,
        sector: c.sector ?? "",
        location: c.location ?? "",
        tier: c.tier ?? "",
        isInternal: c.is_internal,
      })),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <PageHeader title="Clients" />
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Client
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading clients…</p>
      ) : clients.length === 0 ? (
        <EmptyState label="No clients yet" />
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
        >
          {clients.map((client) => (
            <ClientCard key={client.id} client={client} />
          ))}
        </div>
      )}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Client"
        draftKey={"add-client"}
        fields={FIELDS}
        submitLabel="Add client"
        onSubmit={async (v) => {
          const { error } = await supabase.from("clients").insert({
            name: (v.name as string).trim(),
            initials: ((v.initials as string) || initialsFrom(v.name as string)).trim().toUpperCase(),
            sector: (v.sector as string)?.trim() || null,
            location: (v.location as string)?.trim() || null,
            tier: (v.tier as string) || null,
            is_internal: v.is_internal === true,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
