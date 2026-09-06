import { useCallback, useEffect, useState } from "react";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { useAuth } from "../../../context/auth";
import { supabase } from "../../../lib/supabase";
import { EMPLOYEE_CATEGORY_LABEL } from "../../../lib/identity";
import type { EmployeeCategory } from "../../../lib/identity";

type Member = {
  name: string;
  initials: string | null;
  category: EmployeeCategory;
  engagement: string | null;
  personal_info: string | null;
  contact_info: string | null;
  active: boolean;
  created_at: string;
};

type Payment = {
  id: string;
  service_rendered: string | null;
  compensation: number | null;
  due_date: string | null;
  payment_date: string | null;
};

type Job = { id: string; compensation: number | null; completed_at: string | null };

/**
 * An employee's own account page.
 *
 * Everything here is self-scoped by RLS — team_members by user_id,
 * contract_payments and job_assignments by is_member() — so it shows this
 * person and nobody else, whatever the query asks for.
 */
export function EmployeeAccountView({ memberId }: { memberId: string }) {
  const { profile } = useAuth();
  const [member, setMember] = useState<Member | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [m, p, j] = await Promise.all([
      supabase
        .from("team_members")
        .select("name, initials, category, engagement, personal_info, contact_info, active, created_at")
        .eq("id", memberId)
        .maybeSingle(),
      supabase
        .from("contract_payments")
        .select("id, service_rendered, compensation, due_date, payment_date")
        .eq("member_id", memberId)
        .order("due_date", { ascending: false, nullsFirst: false }),
      supabase
        .from("job_assignments")
        .select("id, compensation, completed_at")
        .eq("member_id", memberId),
    ]);
    setMember((m.data ?? null) as Member | null);
    setPayments((p.data ?? []) as Payment[]);
    setJobs((j.data ?? []) as Job[]);
    setLoading(false);
  }, [memberId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const money = (v: number) => v.toFixed(2);
  // Two different questions: what has been paid, and what is owed for work
  // already delivered but not yet on a payment line.
  const paid = payments.filter((p) => p.payment_date);
  const outstanding = payments.filter((p) => !p.payment_date);
  const paidTotal = paid.reduce((s, p) => s + Number(p.compensation ?? 0), 0);
  const outstandingTotal = outstanding.reduce((s, p) => s + Number(p.compensation ?? 0), 0);
  const jobsDone = jobs.filter((j) => j.completed_at).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Paid to date">
          <p className="text-2xl font-semibold text-card-foreground">{money(paidTotal)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {paid.length} payment{paid.length === 1 ? "" : "s"}
          </p>
        </Panel>
        <Panel title="Awaiting payment">
          <p className="text-2xl font-semibold text-card-foreground">{money(outstandingTotal)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {outstanding.length === 0 ? "Nothing outstanding" : `${outstanding.length} line${outstanding.length === 1 ? "" : "s"}`}
          </p>
        </Panel>
        <Panel title="Jobs completed">
          <p className="text-2xl font-semibold text-card-foreground">{jobsDone}</p>
          <p className="mt-1 text-xs text-muted-foreground">of {jobs.length} assigned</p>
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Your details">
          <dl className="space-y-1.5 text-sm">
            {[
              ["Name", member?.name],
              ["Role", member ? EMPLOYEE_CATEGORY_LABEL[member.category] : null],
              ["Engagement", member?.engagement],
              ["With us since", member?.created_at?.slice(0, 10)],
            ].map(([label, value]) =>
              value ? (
                <div key={label as string} className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="capitalize text-card-foreground">{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </Panel>

        <Panel title="Contact">
          <dl className="space-y-1.5 text-sm">
            <div className="flex min-w-0 gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">Login email</dt>
              <dd className="truncate text-card-foreground">{profile?.email ?? "—"}</dd>
            </div>
            {member?.contact_info && (
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">On file</dt>
                <dd className="whitespace-pre-wrap text-card-foreground">{member.contact_info}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Ask an admin to update your details or reset your password.
          </p>
        </Panel>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Payments</h2>
        <DataTable
          columns={["For", "Amount", "Due", "Paid"]}
          emptyLabel="No payments recorded yet — these appear once an admin raises them against your work"
          rows={payments.map((p) => [
            p.service_rendered ?? "—",
            money(Number(p.compensation ?? 0)),
            p.due_date ?? "—",
            p.payment_date ?? (
              <span key="s" className="text-muted-foreground">
                Awaiting
              </span>
            ),
          ])}
        />
      </div>
    </div>
  );
}
