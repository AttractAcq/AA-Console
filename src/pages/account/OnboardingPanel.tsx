import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Play } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ConfirmModal } from "../../components/forms/FormModal";
import { supabase } from "../../lib/supabase";

type Step = { id: string; title: string; status: string; completed_at: string | null };

export function OnboardingPanel() {
  const [startOpen, setStartOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [steps, setSteps] = useState<Step[]>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_onboarding_steps")
      .select("id, title, status, completed_at")
      .eq("client_id", clientId)
      .order("display_order");
    setSteps((data ?? []) as Step[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(step: Step) {
    const next = step.status === "complete" ? "pending" : "complete";
    await supabase
      .from("client_onboarding_steps")
      .update({ status: next, completed_at: next === "complete" ? new Date().toISOString() : null })
      .eq("id", step.id);
    void refresh();
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Play} onClick={() => setStartOpen(true)}>
          Start
        </Button>
      </div>

      <DataTable
        columns={["Step", "Status", ""]}
        emptyLabel="Onboarding has not been started"
        rows={steps.map((s) => [
          s.title,
          s.status === "complete" ? "Complete" : "Pending",
          <button
            key={s.id}
            type="button"
            onClick={() => void toggle(s)}
            className="text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {s.status === "complete" ? "Reopen" : "Mark complete"}
          </button>,
        ])}
      />

      <ConfirmModal
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="Start onboarding"
        body="Creates the three-step checklist for this client: Onboarding Form, Onboarding Call, Credentials Collected. Safe to run twice."
        confirmLabel="Start"
        onConfirm={async () => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("start_onboarding", { p_client_id: clientId });
          if (error) throw new Error(error.message);
        }}
        onDone={refresh}
      />
    </div>
  );
}
