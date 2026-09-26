import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { FieldControl } from "../forms/fields";
import type { FormValues } from "../forms/fields";
import { supabase } from "../../lib/supabase";
import { detailFields, leadFieldsPayload, leadFormValues, type OwnerOption } from "./leadDetails";
import { STAGE_OPTIONS, stageLabel, type LeadStage } from "./stages";
import type { Lead, LeadEvent } from "./types";

type Tab = "details" | "move" | "timeline" | "archive";

export function LeadEditModal({ lead, owners, onClose, onChanged, onArchived }: {
  lead: Lead | null;
  owners: OwnerOption[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onArchived: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const [values, setValues] = useState<FormValues>({});
  const [targetStage, setTargetStage] = useState<LeadStage>("profile_visit");
  const [moveNote, setMoveNote] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [events, setEvents] = useState<LeadEvent[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!lead) return;
    setTab("details");
    setValues(leadFormValues(lead));
    setTargetStage(lead.stage);
    setMoveNote("");
    setNote("");
    setReason("");
    setConfirmArchive(false);
    setError("");
    setSaved("");
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadEvents() {
    if (!lead) return;
    const { data, error: loadError } = await supabase.from("lead_events")
      .select("id, kind, body, from_stage, to_stage, occurred_at")
      .eq("lead_id", lead.id).order("occurred_at", { ascending: false });
    if (loadError) throw loadError;
    setEvents((data ?? []) as LeadEvent[]);
  }

  useEffect(() => {
    if (lead && tab === "timeline") void loadEvents().catch((cause) => setError(message(cause)));
  }, [lead?.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await action();
      setSaved("Saved");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!lead) return null;

  return <Modal open onClose={onClose} title={`Edit ${lead.name ?? "lead"}`}>
    <div className="space-y-4">
      <div role="tablist" aria-label="Lead settings" className="flex flex-wrap gap-2 border-b border-border pb-2">
        {(["details", "move", "timeline", "archive"] as Tab[]).map((item) =>
          <button key={item} type="button" role="tab" aria-selected={tab === item}
            onClick={() => { setTab(item); setError(""); setSaved(""); }}
            className={`rounded px-2 py-1 text-sm capitalize ${tab === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}>
            {item === "move" ? "Move to" : item}
          </button>)}
      </div>

      {tab === "details" && <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const fields = leadFieldsPayload(values);
          const { error: saveError } = await supabase.rpc("update_lead", { p_lead_id: lead.id, p_fields: fields });
          if (saveError) throw saveError;
          await onChanged();
        });
      }}>
        {detailFields(owners).map((field) => <FieldControl key={field.name} field={field}
          value={values[field.name] ?? ""}
          onChange={(value) => setValues((previous) => ({ ...previous, [field.name]: value }))} />)}
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Save details</button>
      </form>}

      {tab === "move" && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Current stage: {stageLabel(lead.stage)}</p>
        <label className="block text-sm font-medium">Move to
          <select aria-label="Move to stage" value={targetStage} onChange={(event) => setTargetStage(event.target.value as LeadStage)}
            className="mt-1 block w-full rounded-md border border-input bg-background p-2">
            {STAGE_OPTIONS.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}{stage.id === lead.stage ? " (current)" : ""}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">Note{targetStage === "lost" ? " (required for Lost)" : " (optional)"}
          <textarea value={moveNote} onChange={(event) => setMoveNote(event.target.value)} className="mt-1 block w-full rounded-md border border-input bg-background p-2" />
        </label>
        <button type="button" disabled={busy || targetStage === lead.stage} onClick={() => void run(async () => {
          if (targetStage === "lost" && !moveNote.trim()) throw new Error("Say why this lead was lost.");
          const { error: moveError } = await supabase.rpc("advance_lead", { p_lead_id: lead.id, p_stage: targetStage, p_note: moveNote.trim() || undefined });
          if (moveError) throw moveError;
          await onChanged();
        })} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Move lead</button>
      </div>}

      {tab === "timeline" && <div className="space-y-3">
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          if (!note.trim()) throw new Error("Write a note first.");
          const { error: noteError } = await supabase.rpc("add_lead_note", { p_lead_id: lead.id, p_note: note.trim() });
          if (noteError) throw noteError;
          setNote("");
          await loadEvents();
          await onChanged();
        }); }} className="space-y-2">
          <label className="block text-sm font-medium">Add note
            <textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 block w-full rounded-md border border-input bg-background p-2" />
          </label>
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Add note</button>
        </form>
        {events.length === 0 ? <p className="text-sm text-muted-foreground">No timeline entries yet.</p> :
          <ol className="space-y-2">{events.map((event) => <li key={event.id} className="rounded border border-border p-2 text-sm">
            <span className="font-medium capitalize">{event.kind.replaceAll("_", " ")}</span>
            <span className="ml-2 text-xs text-muted-foreground">{new Date(event.occurred_at).toLocaleString()}</span>
            {event.from_stage && event.to_stage && <p>{stageLabel(event.from_stage)} → {stageLabel(event.to_stage)}</p>}
            {event.body && <p className="whitespace-pre-wrap">{event.body}</p>}
          </li>)}</ol>}
      </div>}

      {tab === "archive" && <div className="space-y-3">
        <p className="text-sm">Archiving removes this lead from the pipeline and reports. Its details and timeline can be recovered later. Leads with cash collected cannot be archived.</p>
        <label className="block text-sm font-medium">Reason (optional)
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-md border border-input bg-background p-2" />
        </label>
        {!confirmArchive ? <button type="button" onClick={() => setConfirmArchive(true)} className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">Archive this lead</button> :
          <div className="rounded-md border border-destructive p-3">
            <p className="mb-2 text-sm">Archive {lead.name ?? "this lead"}?</p>
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              const { error: archiveError } = await supabase.rpc("archive_lead", { p_lead_id: lead.id, p_reason: reason.trim() || null });
              if (archiveError) throw archiveError;
              await onArchived();
              onClose();
            })} className="rounded-md bg-destructive px-3 py-2 text-sm text-destructive-foreground disabled:opacity-50">Confirm archive</button>
            <button type="button" onClick={() => setConfirmArchive(false)} className="ml-2 text-sm">Cancel</button>
          </div>}
      </div>}

      {saved && <p role="status" className="text-sm text-brand-strong">{saved}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </Modal>;
}

function message(cause: unknown) {
  return (cause as { message?: string })?.message ?? "Could not save this lead.";
}
