import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { supabase } from "../../lib/supabase";
import { stageLabel, type LeadStage } from "./stages";
import type { LeadEvent } from "./types";

export type ArchivedLead = {
  id: string;
  name: string | null;
  stage_at_archive: LeadStage;
  lead: Record<string, unknown>;
  events: LeadEvent[];
  reason: string | null;
  archived_at: string;
  archived_by: string | null;
};

export function ArchivedLeadsModal({ open, rows, onClose, onRecovered }: {
  open: boolean;
  rows: ArchivedLead[];
  onClose: () => void;
  onRecovered: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const current = rows.find((row) => row.id === viewing);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setViewing(null);
    setError("");
    const ids = [...new Set(rows.map((row) => row.archived_by).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    void supabase.from("profiles").select("id, full_name").in("id", ids).then(({ data }) => {
      setNames(Object.fromEntries((data ?? []).map((profile) => [profile.id, profile.full_name ?? profile.id])));
    });
  }, [open, rows]);

  async function recover(row: ArchivedLead) {
    if (!window.confirm(`Recover ${row.name ?? "this lead"} to ${stageLabel(row.stage_at_archive)}?`)) return;
    setBusy(row.id);
    setError("");
    try {
      const { error: recoverError } = await supabase.rpc("recover_lead", { p_lead_id: row.id });
      if (recoverError) throw recoverError;
      await onRecovered();
      setViewing(null);
    } catch (cause) {
      setError((cause as { message?: string })?.message ?? "Could not recover this lead.");
    } finally {
      setBusy(null);
    }
  }

  return <Modal open={open} onClose={onClose} title="Archived leads">
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {current ? <div className="space-y-3 text-sm">
      <button type="button" onClick={() => setViewing(null)} className="text-brand-strong hover:underline">← Archive list</button>
      <h3 className="font-semibold">{current.name ?? "Unnamed lead"}</h3>
      <dl className="grid gap-2 sm:grid-cols-2">{Object.entries(current.lead)
        .filter(([key]) => !["id", "client_id", "updated_at"].includes(key))
        .map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{key.replaceAll("_", " ")}</dt>
          <dd className="break-words">{value == null ? "—" : String(value)}</dd></div>)}</dl>
      <h4 className="font-semibold">Timeline</h4>
      {current.events.length === 0 ? <p>No timeline entries.</p> : <ol className="space-y-2">{current.events.map((event) =>
        <li key={event.id} className="rounded border border-border p-2">
          <span className="capitalize">{event.kind.replaceAll("_", " ")}</span>
          <span className="ml-2 text-muted-foreground">{new Date(event.occurred_at).toLocaleString()}</span>
          {event.body && <p>{event.body}</p>}
        </li>)}</ol>}
    </div> : <div className="space-y-3">
      <label className="block text-sm font-medium">Search by name
        <input value={search} onChange={(event) => setSearch(event.target.value)} className="mt-1 block w-full rounded-md border border-input bg-background p-2" />
      </label>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No archived leads. Archive a lead from its Edit button.</p> :
        <div className="overflow-x-auto"><table className="w-full min-w-max text-left text-sm">
          <thead><tr>{["Name", "Stage when archived", "Worth", "Archived", "By", "Reason", "Actions"].map((heading) => <th key={heading} className="px-2 py-2">{heading}</th>)}</tr></thead>
          <tbody>{rows.filter((row) => (row.name ?? "").toLowerCase().includes(search.toLowerCase())).map((row) => <tr key={row.id} className="border-t border-border">
            <td className="px-2 py-2">{row.name ?? "Unnamed"}</td>
            <td className="px-2 py-2">{stageLabel(row.stage_at_archive)}</td>
            <td className="px-2 py-2">{row.lead.opportunity_value == null ? "—" : `R${Number(row.lead.opportunity_value).toLocaleString()}`}</td>
            <td className="px-2 py-2">{new Date(row.archived_at).toLocaleDateString()}</td>
            <td className="px-2 py-2">{row.archived_by ? names[row.archived_by] ?? row.archived_by : "—"}</td>
            <td className="max-w-48 truncate px-2 py-2">{row.reason ?? "—"}</td>
            <td className="space-x-2 px-2 py-2">
              <button type="button" onClick={() => setViewing(row.id)} className="text-brand-strong hover:underline">View</button>
              <button type="button" disabled={busy !== null} onClick={() => void recover(row)} className="text-brand-strong hover:underline disabled:opacity-50">Recover</button>
            </td>
          </tr>)}</tbody>
        </table></div>}
    </div>}
  </Modal>;
}
