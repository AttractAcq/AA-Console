import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { PIPELINE_STAGE_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type PipelineStage = Database["public"]["Enums"]["pipeline_stage"];

type Lead = {
  id: string;
  name: string | null;
  contact: string | null;
  pipeline_stage: string;
};

const STAGES = [
  { id: "first_touch", label: "First Touch" },
  { id: "second_touch", label: "Second Touch" },
  { id: "call_booked", label: "Call Booked" },
];

const FIELDS: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  {
    name: "contact",
    label: "Contact",
    kind: "text",
    required: true,
    placeholder: "Email, phone or handle",
  },
  { name: "pipeline_stage", label: "Stage", kind: "select", options: PIPELINE_STAGE_OPTIONS },
  { name: "source", label: "Source", kind: "text" },
];

export function ProspectsLeadsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [leads, setLeads] = useState<Lead[]>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_leads")
      .select("id, name, contact, pipeline_stage")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    setLeads((data ?? []) as Lead[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Lead
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {STAGES.map((stage) => {
          const inStage = leads.filter((l) => l.pipeline_stage === stage.id);
          return (
            <div key={stage.id} className="flex flex-col rounded-lg border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-card-foreground">{stage.label}</h2>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                  {inStage.length}
                </span>
              </div>
              {inStage.length === 0 ? (
                <EmptyState label={stage.label} minHeight={360} />
              ) : (
                <div className="space-y-2">
                  {inStage.map((lead) => (
                    <div key={lead.id} className="rounded-md border border-border p-3">
                      <p className="text-sm font-medium text-foreground">{lead.name}</p>
                      <p className="text-xs text-muted-foreground">{lead.contact}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Lead"
        draftKey={`lead:${clientId}`}
        fields={FIELDS}
        submitLabel="Add lead"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.from("client_leads").insert({
            client_id: clientId,
            name: (v.name as string).trim(),
            contact: (v.contact as string).trim(),
            pipeline_stage: ((v.pipeline_stage as string) || "first_touch") as PipelineStage,
            source: (v.source as string)?.trim() || null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
