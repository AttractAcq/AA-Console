import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { fetchLaunchSteps, type LaunchDue, type LaunchStep } from "../../lib/campaignLaunch";

/**
 * Whether a campaign is live — G08.
 *
 * Before this, the question had no single answer: a campaign read `active`,
 * its Meta objects existed, its page was published, and none of that was
 * evidence that money was moving or that anybody had seen it.
 *
 * So the panel is deliberately two halves, and the heading on each says whose
 * part it is. "We did our part" is approvals and executions. "Live" is a fact
 * about the world — a post that went out, or spend recorded. The second does
 * not follow from the first, and the layout is built so nobody can read it
 * as if it did.
 *
 * The verdict sentence is the view's, not this component's. A screen that
 * composed its own wording would drift from the sentence the database gives
 * every other reader, and this is the one question people quote at each other.
 */
export function CampaignLaunchGate({ due }: { due: LaunchDue }) {
  const [steps, setSteps] = useState<LaunchStep[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const campaignId = due.campaign_id;

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      setSteps(await fetchLaunchSteps(campaignId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the launch steps.");
    }
  }, [campaignId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const live = due.live === true;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="font-semibold">Is it live</h3>
        <span
          className={
            live
              ? "rounded px-2 py-0.5 text-xs font-semibold text-brand-strong"
              : "rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground"
          }
        >
          {live ? "Live" : "Not live"}
        </span>
      </div>

      <p className={live ? "text-sm text-brand-strong" : "text-sm"}>{due.verdict}</p>

      {due.status_claims_live === true && !live && (
        <p className="text-xs text-muted-foreground">
          The campaign row reads <code>live</code>. That status is set from an internal checklist
          and is not evidence, which is why it does not change the verdict above.
        </p>
      )}

      {due.warning && (
        <p role="alert" className="text-sm text-amber-600">
          {due.warning}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Fact label="Actions done" value={`${due.actions_done ?? 0}/${due.required_actions ?? 0}`} />
        {due.acquisition_mode === "organic" ? (
          <Fact label="Posts published" value={String(due.posts_published ?? 0)} />
        ) : (
          <Fact
            label="Spending days"
            value={due.spend_bindable ? String(due.spending_days ?? 0) : "unknown"}
          />
        )}
        <Fact label="Pages live / probed" value={`${due.pages_published ?? 0} / ${due.pages_probed ?? 0}`} />
        <Fact label="Leads attributed" value={String(due.leads_attributed ?? 0)} />
      </dl>

      {!due.spend_bindable && due.acquisition_mode === "paid" && (
        <p className="text-xs text-muted-foreground">
          No external campaign id is bound, so spend cannot be read from here at all. That is a
          different problem from a campaign that is bound and spending nothing.
        </p>
      )}

      <Button onClick={() => setOpen((v) => !v)}>
        {open ? "Hide the steps" : "What is still ours to do"}
      </Button>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {open && (
        <DataTable
          columns={["Deliverable", "Action", "State"]}
          emptyLabel="This campaign's manifest needs no external action"
          rows={steps.map((step) => [
            <span key="d" className="font-mono text-xs">{step.item_key}</span>,
            <span key="a" className="font-mono text-xs">
              {step.action_key ?? "—"}
              {step.action_supported === false && (
                <span className="block text-muted-foreground">no adapter</span>
              )}
            </span>,
            <span
              key="s"
              className={step.blocker ? "text-xs" : "text-xs text-brand-strong"}
            >
              {step.blocker ?? "Done."}
            </span>,
          ])}
        />
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
