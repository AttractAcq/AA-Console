import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable } from "../../components/DataTable";
import { FilterPills } from "../../components/FilterPills";
import { useOperationalCampaigns } from "../campaigns/useOperationalCampaigns";

export function CampaignsPanel() {
  const { rows, clients, readiness, loading, error, readinessError } = useOperationalCampaigns();
  const [client, setClient] = useState("");
  const [status, setStatus] = useState("all");
  if (loading) return <p>Loading campaigns…</p>;
  if (error) return <p role="alert">{error}</p>;
  const ready = (id: string) => !!readiness[id]?.length && readiness[id].every(r => r.met);
  const visible = rows.filter(r => (!client || r.client_id === client) &&
    (status === "all" || (status === "ready" ? r.status === "planning" && ready(r.id) : r.status === status)));
  return <div className="space-y-4">
    <label>Client <select value={client} onChange={e => setClient(e.target.value)} className="rounded border border-border bg-card p-2">
      <option value="">All clients</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></label>
    <FilterPills activeId={status} onChange={setStatus} options={[
      { id: "all", label: "All" }, { id: "planning", label: "Planning" },
      { id: "ready", label: "Ready to Launch" }, { id: "live", label: "Live" },
      { id: "complete", label: "Complete" }, { id: "cancelled", label: "Cancelled" },
    ]} />
    {readinessError && <p role="alert">{readinessError}</p>}
    <DataTable columns={["Client", "Campaign", "Status", "Objective", "Channels", "Start", "End", "Content readiness", "Landing page required", "Sales agent required"]}
      emptyLabel={rows.length ? "No campaigns match these filters" : "No campaigns yet"}
      rows={visible.map(r => [
        clients.find(c => c.id === r.client_id)?.name ?? r.client_id,
        <Link to={`/clients/${r.client_id}/delivery/campaign-execution`} key={r.id} className="text-brand-strong underline">{r.name}</Link>,
        r.status === "planning" && ready(r.id) ? "Ready to Launch" : r.status,
        r.objective ?? "—", (r.channels ?? []).join(", ") || "—", r.starts_on ?? "—", r.ends_on ?? "—",
        readiness[r.id]?.find(check => check.requirement === "Content")?.detail ?? (readiness[r.id]?.length ? "No content required" : "Readiness unavailable"),
        r.needs_landing_page ? "Yes" : "No", r.needs_sales_agent ? "Yes" : "No",
      ])} />
  </div>;
}
