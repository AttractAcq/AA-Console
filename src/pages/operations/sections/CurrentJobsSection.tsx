import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { FormModal } from "../../../components/forms/FormModal";
import type { FieldDef } from "../../../components/forms/fields";
import { loadBriefs, loadClients, useOptions } from "../../../lib/options";
import { supabase } from "../../../lib/supabase";

type Job = {
  id: string;
  title: string;
  due_date: string | null;
  compensation: number | null;
  completed_at: string | null;
};

export function CurrentJobsSection() {
  const [assignOpen, setAssignOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const clientOptions = useOptions(loadClients, assignOpen);
  const briefOptions = useOptions(loadBriefs, assignOpen);

  const refresh = useCallback(async () => {
    if (!memberId) return;
    const { data } = await supabase
      .from("job_assignments")
      .select("id, title, due_date, compensation, completed_at")
      .eq("member_id", memberId)
      .order("due_date", { nullsFirst: false });
    setJobs((data ?? []) as Job[]);
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
      options: briefOptions,
      hint: "The assignee opens this from the Brief button on their job.",
    },
    { name: "due_date", label: "Due date", kind: "date" },
    { name: "compensation", label: "Compensation", kind: "number" },
  ];

  const open = jobs.filter((j) => !j.completed_at);
  const nextDue = open.find((j) => j.due_date)?.due_date ?? "—";

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
          columns={["Current Jobs", "Due Date", "Compensation"]}
          emptyLabel="No current jobs yet"
          rows={jobs.map((j) => [j.title, j.due_date ?? "—", j.compensation ?? "—"])}
        />
      </div>

      <FormModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Assign Job"
        draftKey={`assign-job:${memberId}`}
        fields={fields}
        submitLabel="Assign"
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          const { error } = await supabase.from("job_assignments").insert({
            member_id: memberId,
            client_id: v.client_id as string,
            title: (v.title as string).trim(),
            brief_id: (v.brief_id as string) || null,
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
