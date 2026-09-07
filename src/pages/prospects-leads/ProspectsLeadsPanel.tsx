import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type LeadStage = Database["public"]["Enums"]["lead_stage"];

type Lead = {
  id: string;
  name: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  stage: LeadStage;
  stage_at: string;
  next_action: string | null;
  next_action_due: string | null;
  opportunity_value: number | null;
  sale_value: number | null;
  cash_collected: number | null;
  source_channel: string | null;
};

type Stalled = {
  id: string;
  name: string | null;
  stage: LeadStage;
  days_in_stage: number;
  next_action: string | null;
  next_action_due: string | null;
  overdue: boolean;
  owner_name: string | null;
};

/**
 * The acquisition chain, in the order it actually happens.
 *
 * Attention is deliberately absent: it is impressions against a post and lives
 * in metrics, and a lead begins when attention becomes a name someone can
 * contact. Putting it here would double-count it and add a column nobody can
 * act on.
 */
const STAGES: Array<{ id: LeadStage; label: string }> = [
  { id: "lead", label: "Lead" },
  { id: "conversation", label: "Conversation" },
  { id: "qualified_conversation", label: "Qualified" },
  { id: "appointment", label: "Appointment" },
  { id: "qualified_appointment", label: "Qualified appt" },
  { id: "shown", label: "Showed" },
  { id: "sale", label: "Sale" },
  { id: "cash", label: "Cash" },
];

const FIELDS: FieldDef[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "email", label: "Email", kind: "text" },
  { name: "phone", label: "Phone", kind: "text" },
  {
    name: "stage",
    label: "Stage",
    kind: "select",
    options: STAGES.map((s) => ({ value: s.id, label: s.label })),
  },
  {
    name: "source_channel",
    label: "Where they came from",
    kind: "text",
    placeholder: "Instagram reel, landing page, referral",
    hint: "Revenue can only be traced back to the content that caused it if this is recorded.",
  },
  {
    name: "next_action",
    label: "Next action",
    kind: "text",
    hint: "A lead with nothing scheduled next is stalled, whatever stage it sits in.",
  },
  { name: "next_action_due", label: "Due", kind: "date" },
  { name: "opportunity_value", label: "Worth", kind: "text", placeholder: "0.00" },
];

const money = (v: number | null) => (v === null ? null : `R${Number(v).toLocaleString()}`);

export function ProspectsLeadsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [addOpen, setAddOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stalled, setStalled] = useState<Stalled[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [rows, stalledRows] = await Promise.all([
      supabase
        .from("client_leads")
        .select(
          "id, name, contact, email, phone, stage, stage_at, next_action, next_action_due, opportunity_value, sale_value, cash_collected, source_channel",
        )
        .eq("client_id", clientId)
        .order("stage_at", { ascending: false }),
      supabase.rpc("stalled_leads", { p_client_id: clientId, p_days: 30 }),
    ]);
    setLeads((rows.data ?? []) as Lead[]);
    setStalled((stalledRows.data ?? []) as Stalled[]);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading pipeline…</p>;

  const open = leads.filter((l) => l.stage !== "cash" && l.stage !== "lost");
  const pipelineValue = open.reduce((sum, l) => sum + Number(l.opportunity_value ?? 0), 0);
  const collected = leads.reduce((sum, l) => sum + Number(l.cash_collected ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* What is sitting still, before what exists. A pipeline board shows
          you the shape; this shows you the work. */}
      {stalled.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {stalled.length} lead{stalled.length === 1 ? "" : "s"} with nothing scheduled next
          </p>
          <ul className="mt-2 space-y-1">
            {stalled.slice(0, 6).map((l) => (
              <li key={l.id} className="text-sm text-foreground">
                <span className="font-medium">{l.name ?? "Unnamed"}</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {STAGES.find((s) => s.id === l.stage)?.label ?? l.stage}
                  {" · "}
                  {l.days_in_stage} day{l.days_in_stage === 1 ? "" : "s"} there
                  {l.overdue ? ` · "${l.next_action}" overdue` : ""}
                  {l.owner_name ? ` · ${l.owner_name}` : " · nobody assigned"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Open leads</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">{open.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Pipeline value</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">
            {money(pipelineValue) ?? "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Cash collected</span>
          <p className="mt-2 text-2xl font-semibold text-card-foreground">
            {money(collected) ?? "—"}
          </p>
        </div>
      </div>

      <div className="mb-2 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Lead
        </Button>
      </div>

      {leads.length === 0 ? (
        <EmptyState label="No leads yet. Nothing has come in from a page, a post or a referral." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STAGES.map((stage) => {
            const inStage = leads.filter((l) => l.stage === stage.id);
            return (
              <div key={stage.id} className="rounded-lg border border-border bg-card p-3.5">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-card-foreground">{stage.label}</h3>
                  <span className="text-xs text-muted-foreground">{inStage.length}</span>
                </div>
                {inStage.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {inStage.map((l) => (
                      <li key={l.id} className="rounded-md border border-border/60 p-2">
                        <p className="truncate text-sm text-foreground">{l.name ?? "Unnamed"}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {l.next_action ?? (
                            <span className="text-destructive">nothing scheduled</span>
                          )}
                        </p>
                        {(l.opportunity_value || l.source_channel) && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {[money(l.opportunity_value), l.source_channel]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Lead"
        draftKey={`lead:${clientId}`}
        fields={FIELDS}
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const worth = String(v.opportunity_value ?? "").trim();
          const { error } = await supabase.from("client_leads").insert({
            client_id: clientId,
            name: (v.name as string).trim(),
            email: (v.email as string)?.trim() || null,
            phone: (v.phone as string)?.trim() || null,
            contact: (v.email as string)?.trim() || (v.phone as string)?.trim() || null,
            stage: ((v.stage as string) || "lead") as LeadStage,
            source_channel: (v.source_channel as string)?.trim() || null,
            next_action: (v.next_action as string)?.trim() || null,
            next_action_due: (v.next_action_due as string) || null,
            opportunity_value: worth ? Number(worth) : null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
