import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type Campaign = {
  id: string;
  name: string;
  brief: string;
  status: string;
  objective: string | null;
  audience: string | null;
  offer_summary: string | null;
  core_message: string | null;
  channels: string[] | null;
  budget: number | null;
  starts_on: string | null;
  ends_on: string | null;
  kpi_metric: string | null;
  kpi_target: number | null;
  content_count: number;
  needs_landing_page: boolean;
  needs_sales_agent: boolean;
  built_at: string | null;
  launched_at: string | null;
  created_at: string;
};

export type Requirement = {
  requirement: string;
  required: number;
  have: number;
  met: boolean;
  detail: string;
};

const FIELDS: FieldDef[] = [
  { name: "name", label: "Campaign name", kind: "text", required: true },
  {
    name: "brief",
    label: "What this campaign is for",
    kind: "textarea",
    rows: 4,
    required: true,
    hint: "The planner writes the objective, audience, message, channels and what has to be built, from this plus your offer strategy and ICP.",
  },
];

const STATUS_TONE: Record<string, string> = {
  planning: "bg-secondary text-secondary-foreground",
  live: "bg-primary/10 text-brand-strong",
  complete: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

export function CampaignExecutionPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [readiness, setReadiness] = useState<Record<string, Requirement[]>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("client_campaigns")
      .select(
        "id, name, brief, status, objective, audience, offer_summary, core_message, channels, budget, starts_on, ends_on, kpi_metric, kpi_target, content_count, needs_landing_page, needs_sales_agent, built_at, launched_at, created_at",
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    const rows = (data ?? []) as Campaign[];
    setCampaigns(rows);

    // Readiness is computed in the database from the real artifacts, never
    // stored — so it is fetched per campaign rather than read off a column.
    const checks = await Promise.all(
      rows.map((c) => supabase.rpc("campaign_readiness", { p_campaign_id: c.id })),
    );
    const next: Record<string, Requirement[]> = {};
    rows.forEach((c, i) => {
      next[c.id] = (checks[i]?.data ?? []) as Requirement[];
    });
    setReadiness(next);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const act = async (
    rpc: "provision_campaign" | "launch_campaign",
    campaign: Campaign,
    done: (n: number) => string,
  ) => {
    setBusy(true);
    setProblem(null);
    const { data, error } = await supabase.rpc(rpc, { p_campaign_id: campaign.id });
    setBusy(false);
    if (error) {
      // The database refusal names the missing requirement. Showing it
      // verbatim is the whole point — "not ready" alone is unactionable.
      setProblem(error.message);
      return;
    }
    // launch_campaign returns nothing; provision_campaign returns a row per
    // artifact it created, and 0 rows is the idempotent case worth naming.
    setNotice(done(Array.isArray(data) ? (data as unknown[]).length : 0));
    void refresh();
  };

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setNewOpen(true)}>
          New Campaign
        </Button>
      </div>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {problem}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaigns.length === 0 ? (
        <EmptyState label="No campaigns yet" />
      ) : (
        <div className="space-y-4">
          {campaigns.map((c) => {
            const reqs = readiness[c.id] ?? [];
            const unmet = reqs.filter((r) => !r.met);
            const ready = reqs.length > 0 && unmet.length === 0;

            return (
              <div key={c.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-card-foreground">{c.name}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.objective ?? c.brief}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                      STATUS_TONE[c.status] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {c.status}
                  </span>
                </div>

                {c.built_at ? (
                  <dl className="mt-3 grid gap-3 border-t border-border pt-3 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">Audience</dt>
                      <dd className="text-card-foreground">{c.audience}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Message</dt>
                      <dd className="text-card-foreground">{c.core_message}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Channels</dt>
                      <dd className="capitalize text-card-foreground">
                        {(c.channels ?? []).join(", ") || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Scored on</dt>
                      <dd className="text-card-foreground">
                        {c.kpi_metric ?? "—"}
                        {c.kpi_target !== null ? ` · target ${c.kpi_target}` : ""}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    Waiting for the planner to write this.
                  </p>
                )}

                <div className="mt-3 border-t border-border pt-3">
                  <h4 className="text-xs font-semibold text-foreground">Before this can launch</h4>
                  {reqs.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">Nothing to check yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {reqs.map((r) => (
                        <li key={r.requirement} className="flex items-baseline gap-2 text-xs">
                          <span
                            aria-hidden
                            className={cn(
                              "inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                              r.met ? "bg-brand-strong" : "bg-destructive",
                            )}
                          />
                          <span className="font-medium text-card-foreground">{r.requirement}</span>
                          <span className="text-muted-foreground">{r.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {c.built_at && (c.needs_landing_page || c.needs_sales_agent) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act("provision_campaign", c, (n) =>
                          n === 0
                            ? "Everything this campaign needs already exists — nothing new was created."
                            : `Queued ${n} build${n === 1 ? "" : "s"}. They appear under Conversion and Sales as they finish.`,
                        )
                      }
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Build what it needs
                    </button>
                  )}
                  {c.status !== "live" && (
                    <button
                      type="button"
                      disabled={busy || !ready}
                      onClick={() => void act("launch_campaign", c, () => `"${c.name}" is live.`)}
                      className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Launch
                    </button>
                  )}
                  {!ready && c.status !== "live" && unmet.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {unmet.length} thing{unmet.length === 1 ? "" : "s"} still missing
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <FormModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Campaign"
        draftKey={`campaign:${clientId}`}
        intro="Queues the Campaign Planner. It needs your offer strategy and ICP, and writes the plan — including what has to be built before this can run."
        fields={FIELDS}
        submitLabel="Plan it"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { data, error } = await supabase
            .from("client_campaigns")
            .insert({
              client_id: clientId,
              name: (v.name as string).trim(),
              brief: (v.brief as string).trim(),
            })
            .select("id")
            .single();
          if (error) throw error;

          const { error: jobError } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "campaign_plan",
            p_client_id: clientId,
            p_input_table: "client_campaigns",
            p_input_id: data.id,
          });
          if (jobError) throw new Error(jobError.message);
          setNotice("Queued. The planner is writing the campaign now.");
        }}
        onSaved={refresh}
      />
    </div>
  );
}
