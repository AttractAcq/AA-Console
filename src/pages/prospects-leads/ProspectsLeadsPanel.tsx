import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Archive, Pencil, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { LeadEditModal } from "../../components/leads/LeadEditModal";
import { ArchivedLeadsModal, type ArchivedLead } from "../../components/leads/ArchivedLeadsModal";
import { detailFields, leadFieldsPayload, type OwnerOption } from "../../components/leads/leadDetails";
import { PIPELINE_STAGES, STAGE_OPTIONS, stageLabel, type LeadStage } from "../../components/leads/stages";
import type { Lead } from "../../components/leads/types";
import type { Database } from "../../types/database";

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

const ADD_STAGE: FieldDef = { name: "stage", label: "Initial stage", kind: "select", options: STAGE_OPTIONS.map((stage) => ({ value: stage.id, label: stage.label })) };
const ADD_INITIAL = { stage: "profile_visit" };

const money = (v: number | null) => (v === null ? null : `R${Number(v).toLocaleString()}`);

export function ProspectsLeadsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [addOpen, setAddOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [archived, setArchived] = useState<ArchivedLead[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  const [stalled, setStalled] = useState<Stalled[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<LeadStage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const moving = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [rows, stalledRows, archivedRows, ownerRows] = await Promise.all([
      supabase
        .from("client_leads")
        .select(
          "id, name, contact, email, phone, stage, stage_at, next_action, next_action_due, opportunity_value, sale_value, cash_collected, source_channel, owner_member_id, appointment_at, appointment_outcome",
        )
        .eq("client_id", clientId)
        .order("stage_at", { ascending: false }),
      supabase.rpc("stalled_leads", { p_client_id: clientId, p_days: 30 }),
      supabase.from("archived_leads").select("id, name, stage_at_archive, lead, events, reason, archived_at, archived_by")
        .eq("client_id", clientId).order("archived_at", { ascending: false }),
      supabase.from("team_members").select("id, name").eq("active", true).order("name"),
    ]);
    const failed = rows.error ?? stalledRows.error ?? archivedRows.error ?? ownerRows.error;
    if (failed) setError(failed.message);
    setLeads((rows.data ?? []) as Lead[]);
    setStalled((stalledRows.data ?? []) as Stalled[]);
    setArchived((archivedRows.data ?? []) as unknown as ArchivedLead[]);
    setOwners((ownerRows.data ?? []) as OwnerOption[]);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function moveLead(leadId: string, stage: LeadStage) {
    const lead = leads.find((row) => row.id === leadId);
    if (!clientId || !lead || lead.stage === stage || moving.current) return;
    moving.current = true;
    setBusyId(leadId);
    setError(null);
    setNotice(null);
    try {
      const { error } = await supabase.rpc("advance_lead", { p_lead_id: leadId, p_stage: stage });
      if (error) throw error;
      await refresh();
      setNotice(`${lead.name ?? "Lead"} moved to ${stageLabel(stage)}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : (error as { message?: string }).message ?? "Could not move this lead.");
    } finally {
      moving.current = false;
      setBusyId(null);
      setDraggedId(null);
      setDropStage(null);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading pipeline…</p>;

  const open = leads.filter((l) => l.stage !== "cash" && l.stage !== "lost");
  const pipelineValue = open.reduce((sum, l) => sum + Number(l.opportunity_value ?? 0), 0);
  const collected = leads.reduce((sum, l) => sum + Number(l.cash_collected ?? 0), 0);
  const selectedLead = leads.find((lead) => lead.id === selectedId) ?? null;
  const lost = leads.filter((lead) => lead.stage === "lost");
  const legacy = leads.filter((lead) => lead.stage === "lead" || lead.stage === "sale");

  function card(lead: Lead) {
    return <li key={lead.id} draggable={busyId === null}
      onDragStart={(event) => {
        setDraggedId(lead.id);
        event.dataTransfer.setData("text/plain", lead.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => { setDraggedId(null); setDropStage(null); }}
      onClick={() => setSelectedId(lead.id)}
      onKeyDown={(event) => { if (event.key === "Enter") setSelectedId(lead.id); }}
      tabIndex={0}
      aria-label={`Open ${lead.name ?? "Unnamed"}`}
      className={`cursor-pointer rounded-md border border-border/60 p-2 ${busyId !== null ? "opacity-60" : ""}`}>
      <p className="truncate text-sm font-medium text-foreground">{lead.name ?? "Unnamed"}</p>
      <p className="truncate text-xs text-muted-foreground">{lead.next_action ?? <span className="text-destructive">nothing scheduled</span>}</p>
      {(lead.opportunity_value != null || lead.source_channel) && <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {[money(lead.opportunity_value), lead.source_channel].filter(Boolean).join(" · ")}</p>}
      <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedId(lead.id); }}
        aria-label={`Edit ${lead.name ?? "Unnamed"}`} className="mt-2 inline-flex items-center gap-1 text-xs text-brand-strong hover:underline">
        <Pencil className="h-3 w-3" aria-hidden="true" />Edit</button>
      {busyId === lead.id && <span role="status" className="ml-2 text-xs text-muted-foreground">Moving…</span>}
    </li>;
  }

  return (
    <div className="space-y-4">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Drag a card to a stage, or open Edit to move it.</p>
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
                  {stageLabel(l.stage)}
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

      <div className="mb-2 flex justify-end gap-2">
        <Button icon={Archive} className="bg-secondary text-secondary-foreground" onClick={() => setArchiveOpen(true)}>Archive ({archived.length})</Button>
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Lead
        </Button>
      </div>

      {leads.length === 0 ? (
        <EmptyState label="No leads yet. Nothing has come in from a page, a post or a referral." />
      ) : (
        <div className="overflow-x-auto pb-3" aria-label="Lead pipeline">
        <div className="flex w-max gap-3">
          {PIPELINE_STAGES.map((stage) => {
            const inStage = leads.filter((l) => l.stage === stage.id);
            return (
              <div key={stage.id}
                aria-label={`${stage.label} stage`}
                onDragOver={(event) => {
                  if (!draggedId || busyId) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropStage(stage.id);
                }}
                onDragLeave={() => setDropStage(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedId) void moveLead(draggedId, stage.id);
                  setDraggedId(null);
                  setDropStage(null);
                }}
                className={`w-72 shrink-0 rounded-lg border border-border bg-card p-3.5 ${dropStage === stage.id ? "ring-2 ring-ring" : ""}`}>

                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-card-foreground">{stage.label}</h3>
                  <span className="text-xs text-muted-foreground">{inStage.length}</span>
                </div>
                {inStage.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {inStage.map(card)}
                  </ul>
                )}
              </div>
            );
          })}
          <div className="w-72 shrink-0 rounded-lg border border-border bg-card p-3.5">
            <button type="button" aria-expanded={lostOpen} onClick={() => setLostOpen((value) => !value)}
              className="w-full text-left text-sm font-semibold">Lost ({lost.length})</button>
            {lostOpen && <ul className="mt-2 space-y-1.5">{lost.map(card)}</ul>}
          </div>
        </div>
        </div>
      )}

      {legacy.length > 0 && <p role="status" className="text-sm text-muted-foreground">
        {legacy.length} lead{legacy.length === 1 ? "" : "s"} in retired stages need administrator cleanup.
      </p>}

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Lead"
        draftKey={`lead:${clientId}`}
        fields={[...detailFields(owners), ADD_STAGE]}
        initialValues={ADD_INITIAL}
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const details = leadFieldsPayload(v);
          const stage = ((v.stage as string) || "profile_visit") as LeadStage;
          if (Number(details.cash_collected ?? 0) > 0 && stage !== "shown" && stage !== "cash")
            throw new Error("Move the lead to Show Ups or Cash Collected before recording cash.");
          const { error } = await supabase.from("client_leads").insert({
            client_id: clientId,
            ...details,
            contact: details.email ?? details.phone,
            stage,
          } as Database["public"]["Tables"]["client_leads"]["Insert"]);
          if (error) throw error;
        }}
        onSaved={refresh}
      />
      <LeadEditModal lead={selectedLead} owners={owners} onClose={() => setSelectedId(null)} onChanged={refresh} onArchived={refresh} />
      <ArchivedLeadsModal open={archiveOpen} rows={archived} onClose={() => setArchiveOpen(false)} onRecovered={refresh} />
    </div>
  );
}
