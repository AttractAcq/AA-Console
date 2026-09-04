import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { Panel } from "../../../components/Panel";
import { DataTable } from "../../../components/DataTable";
import { FormModal } from "../../../components/forms/FormModal";
import type { FieldDef } from "../../../components/forms/fields";
import { supabase } from "../../../lib/supabase";

type Payment = {
  id: string;
  service_rendered: string;
  compensation: number;
  due_date: string | null;
  payment_date: string | null;
};

const FIELDS: FieldDef[] = [
  { name: "service_rendered", label: "Service rendered", kind: "text", required: true },
  { name: "compensation", label: "Compensation", kind: "number", required: true },
  {
    name: "due_date",
    label: "Due date",
    kind: "date",
    hint: "Leave the payment unmarked until it is actually paid — unpaid rows are what Pay Due sums.",
  },
];

export function ContractSection() {
  const [addOpen, setAddOpen] = useState(false);
  const { memberId } = useParams<{ memberId: string }>();
  const [payments, setPayments] = useState<Payment[]>([]);

  const refresh = useCallback(async () => {
    if (!memberId) return;
    const { data } = await supabase
      .from("contract_payments")
      .select("id, service_rendered, compensation, due_date, payment_date")
      .eq("member_id", memberId)
      .order("due_date", { nullsFirst: false });
    setPayments((data ?? []) as Payment[]);
  }, [memberId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unpaid = payments.filter((p) => !p.payment_date);
  const payDue = unpaid.reduce((sum, p) => sum + Number(p.compensation), 0);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add Payment
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="Pay Due">
            <p className="text-2xl font-semibold text-card-foreground">{payDue.toFixed(2)}</p>
          </Panel>
          <Panel title="Due Date">
            <p className="text-2xl font-semibold text-card-foreground">
              {unpaid.find((p) => p.due_date)?.due_date ?? "—"}
            </p>
          </Panel>
        </div>
        <DataTable
          columns={["Service Rendered", "Compensation", "Payment Date"]}
          emptyLabel="No payments yet"
          rows={payments.map((p) => [
            p.service_rendered,
            Number(p.compensation).toFixed(2),
            p.payment_date ?? "Unpaid",
          ])}
        />
      </div>

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Payment"
        draftKey={`add-payment:${memberId}`}
        fields={FIELDS}
        submitLabel="Add payment"
        onSubmit={async (v) => {
          if (!memberId) throw new Error("No team member selected.");
          const { error } = await supabase.from("contract_payments").insert({
            member_id: memberId,
            service_rendered: (v.service_rendered as string).trim(),
            compensation: Number(v.compensation),
            due_date: (v.due_date as string) || null,
          });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
