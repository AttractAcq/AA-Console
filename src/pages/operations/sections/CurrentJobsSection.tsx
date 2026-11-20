import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { FormModal } from "../../../components/forms/FormModal";
import type { FieldDef, Option } from "../../../components/forms/fields";
import { loadBriefs, loadClients, loadProductionDemands, useOptions } from "../../../lib/options";
import { supabase } from "../../../lib/supabase";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Job = {
  id: string;
  title: string;
  due_date: string | null;
  compensation: number | null;
  completed_at: string | null;
  demand: string | null;
};

export function CurrentJobsSection() {
  const [assignOpen, setAssignOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const clientOptions = useOptions(loadClients, assignOpen);
  const [selection, setSelection] = useState({ clientId: "", briefId: "", demandSearch: "" });
  const [briefLookup, setBriefLookup] = useState<{
    key: string; options: Option[]; error: string | null; loading: boolean;
  }>({ key: "", options: [], error: null, loading: false });
  const briefOptions = briefLookup.key === selection.clientId ? briefLookup.options : [];
  const [demandLookup, setDemandLookup] = useState<{
    key: string; options: Option[]; error: string | null; loading: boolean;
  }>({ key: "", options: [], error: null, loading: false });
  const demandKey = `${selection.clientId}:${selection.briefId}:${selection.demandSearch.trim()}`;
  const demandOptions = demandLookup.key === demandKey ? demandLookup.options : [];

  useEffect(() => {
    if (!assignOpen || !selection.clientId) return;
    let active = true;
    setBriefLookup({ key: selection.clientId, options: [], error: null, loading: true });
    void loadBriefs(selection.clientId).then((options) => {
      if (active) setBriefLookup({ key: selection.clientId, options, error: null, loading: false });
    }).catch((error: unknown) => {
      if (active) setBriefLookup({ key: selection.clientId, options: [],
        error: error instanceof Error ? error.message : "Could not find client briefs.", loading: false });
    });
    return () => { active = false; };
  }, [assignOpen, selection.clientId]);

  useEffect(() => {
    if (!assignOpen || !selection.clientId || !UUID_PATTERN.test(selection.briefId)) return;
    let active = true;
    setDemandLookup({ key: demandKey, options: [], error: null, loading: true });
    const timer = window.setTimeout(() => {
      void loadProductionDemands(selection.clientId, selection.briefId, selection.demandSearch).then((options) => {
        if (active) setDemandLookup({ key: demandKey, options, error: null, loading: false });
      }).catch((error: unknown) => {
        if (active) setDemandLookup({ key: demandKey, options: [],
          error: error instanceof Error ? error.message : "Could not find matching requests.", loading: false });
      });
    }, selection.demandSearch ? 300 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [assignOpen, selection.clientId, selection.briefId, selection.demandSearch, demandKey]);

  const refresh = useCallback(async () => {
    if (!memberId) return;
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("job_assignments")
        .select("id, title, due_date, compensation, completed_at")
        .eq("member_id", memberId)
        .order("due_date", { nullsFirst: false });
      if (error) throw error;
      const rows = (data ?? []) as Omit<Job, "demand">[];
      const bindings = rows.length ? await supabase
        .from("assignment_demand_bindings_v7")
        .select("assignment_id, demand_kind, demand_id")
        .in("assignment_id", rows.map((row) => row.id))
        : { data: [], error: null };
      if (bindings.error) throw bindings.error;
      const byAssignment = new Map((bindings.data ?? []).map((binding) =>
        [binding.assignment_id, `${binding.demand_kind} · ${binding.demand_id.slice(0, 8)}`]));
      setJobs(rows.map((row) => ({ ...row, demand: byAssignment.get(row.id) ?? null })));
    } catch (error) {
      setLoadError("Failed to load current jobs: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fields: FieldDef[] = [
    { name: "title", label: "Job", kind: "text", required: true },
    {
      name: "client_id",
      label: "Client",
      kind: "select",
      required: true,
      options: clientOptions,
      hint: "Grants this member upload access to that client's media.",
    },
    {
      name: "brief_id",
      label: "Brief",
      kind: "select",
      options: [{ value: "manual", label: "Enter an exact brief ID" }, ...briefOptions],
      hint: "Choose a brief for this client. The assignee opens it from the Brief button on their job.",
    },
    { name: "manual_brief_id", label: "Exact brief ID", kind: "text", required: true,
      showIf: { field: "brief_id", equals: ["manual"] } },
    { name: "demand_search", label: "Find request by piece key", kind: "text",
      hint: "Search this brief's requests, including older work beyond the first 200 results." },
    {
      name: "production_demand",
      label: "Campaign or daily request",
      kind: "select",
      options: [{ value: "manual", label: "Enter an exact request ID" }, ...demandOptions],
      hint: "Choose a listed request or enter its full ID. The brief must belong to that request.",
    },
    {
      name: "manual_demand_kind", label: "Request type", kind: "select", required: true,
      options: [{ value: "campaign", label: "Campaign" }, { value: "daily", label: "Daily" }],
      showIf: { field: "production_demand", equals: ["manual"] },
    },
    {
      name: "manual_demand_id", label: "Exact request ID", kind: "text", required: true,
      showIf: { field: "production_demand", equals: ["manual"] },
    },
    { name: "due_date", label: "Due date", kind: "date" },
    { name: "compensation", label: "Compensation", kind: "number" },
  ];

  const open = jobs.filter((j) => !j.completed_at);
  const nextDue = open.find((j) => j.due_date)?.due_date ?? "—";

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAssignOpen(true)}>
          Assign Job
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Job Count">
            <p className="text-2xl font-semibold text-card-foreground">{open.length}</p>
          </Panel>
          <Panel title="Due Date">
            <p className="text-2xl font-semibold text-card-foreground">{nextDue}</p>
          </Panel>
        </div>
        <DataTable
          columns={["Current Jobs", "Request", "Due Date", "Compensation"]}
          emptyLabel="No current jobs yet"
          rows={jobs.map((j) => [j.title, j.demand ?? "Unlinked", j.due_date ?? "—", j.compensation ?? "—"])}
        />
      </div>

      <FormModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Assign Job"
        draftKey={`assign-job:${memberId}`}
        fields={fields}
        intro={selection.clientId
          ? <>{briefLookup.key === selection.clientId && briefLookup.loading
                && <p>Finding this client’s briefs…</p>}
              {briefLookup.key === selection.clientId && briefLookup.error
                && <p role="alert">{briefLookup.error}</p>}
              {briefLookup.key === selection.clientId && !briefLookup.loading && !briefLookup.error
                && briefOptions.length === 0 && <p>No recent briefs found. Enter an exact brief ID if needed.</p>}
              {selection.briefId && demandLookup.key === demandKey && demandLookup.loading
                && <p>Finding requests for this brief…</p>}
              {selection.briefId && demandLookup.key === demandKey && demandLookup.error
                && <p role="alert">{demandLookup.error}</p>}
              {selection.briefId && demandLookup.key === demandKey && !demandLookup.loading
                && !demandLookup.error && demandOptions.length === 0
                && <p>No matching requests found. Try a piece-key search or enter the exact request ID.</p>}</>
          : undefined}
        onValuesChange={(values) => {
          const clientId = typeof values.client_id === "string" ? values.client_id : "";
          const chosenBrief = typeof values.brief_id === "string" ? values.brief_id : "";
          const briefId = chosenBrief === "manual" && typeof values.manual_brief_id === "string"
            ? values.manual_brief_id.trim() : chosenBrief;
          const demandSearch = typeof values.demand_search === "string" ? values.demand_search : "";
          setSelection((previous) => previous.clientId === clientId && previous.briefId === briefId
            && previous.demandSearch === demandSearch
            ? previous : { clientId, briefId, demandSearch });
        }}
        submitLabel="Assign"
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          const chosenBrief = String(v.brief_id ?? "");
          const briefId = chosenBrief === "manual"
            ? String(v.manual_brief_id ?? "").trim() : chosenBrief;
          if (chosenBrief === "manual" && !UUID_PATTERN.test(briefId)) {
            throw new Error("Enter the full brief ID.");
          }
          if (chosenBrief && chosenBrief !== "manual"
            && !briefOptions.some((option) => option.value === chosenBrief)) {
            throw new Error("This brief no longer matches the selected client.");
          }
          const selectedDemand = String(v.production_demand ?? "");
          if (selectedDemand) {
            const [kind, demandId] = selectedDemand === "manual"
              ? [String(v.manual_demand_kind ?? ""), String(v.manual_demand_id ?? "").trim()]
              : selectedDemand.split(":");
            if (!UUID_PATTERN.test(briefId) || !UUID_PATTERN.test(demandId)
              || (kind !== "daily" && kind !== "campaign")) {
              throw new Error("Select a brief and exact production request.");
            }
            if (selectedDemand !== "manual" && !demandOptions.some((option) => option.value === selectedDemand)) {
              throw new Error("This request no longer matches the selected client and brief.");
            }
            const { error } = await supabase.rpc("create_demand_assignment_v7", {
              p_member_id: memberId,
              p_client_id: v.client_id as string,
              p_brief_id: briefId,
              p_demand_kind: kind,
              p_demand_id: demandId,
              p_title: (v.title as string).trim(),
              p_due_date: (v.due_date as string) || undefined,
              p_compensation: v.compensation ? Number(v.compensation) : undefined,
            });
            if (error) throw error;
            return;
          }
          const { error } = await supabase.from("job_assignments").insert({
            member_id: memberId,
            client_id: v.client_id as string,
            title: (v.title as string).trim(),
            brief_id: briefId || null,
            due_date: (v.due_date as string) || null,
            compensation: v.compensation ? Number(v.compensation) : null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
