import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { clearDraft } from "../../components/forms/FormModal";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";
import { CampaignContentPanel } from "./CampaignContentPanel";
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
  content_ideas_generated_at: string | null;
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
  const [contentCampaignId, setContentCampaignId] = useState<string | null>(null);
  // Collapsed on load, every time. A client with fifteen campaigns opened a
  // page of fifteen full cards; nobody scrolls that to find one.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ name: string; brief: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoadError(null);
    setReadinessError(null);
    setLoading(true);
    setReadiness({});
    try {
      if (!clientId) {
        throw new Error("No client selected.");
      }
      const { data, error } = await supabase
        .from("client_campaigns")
        .select(
          "id, name, brief, status, objective, audience, offer_summary, core_message, channels, budget, starts_on, ends_on, kpi_metric, kpi_target, content_count, needs_landing_page, needs_sales_agent, built_at, content_ideas_generated_at, launched_at, created_at",
        )
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (version !== request.current) return;
      if (error) throw error;
      const rows = (data ?? []) as Campaign[];
      setCampaigns(rows);

      // Readiness is computed in the database from the real artifacts, never
      // stored — so it is fetched per campaign rather than read off a column.
      const checks = await Promise.allSettled(
        rows.map((c) => supabase.rpc("campaign_readiness", { p_campaign_id: c.id })),
      );
      const next: Record<string, Requirement[]> = {};
      if (version !== request.current) return;
      rows.forEach((c, i) => {
        const check = checks[i];
        if (check.status === "rejected" || check.value.error) {
          setReadinessError("Failed to load readiness. Launch is disabled for unchecked campaigns.");
        } else next[c.id] = (check.value.data ?? []) as Requirement[];
      });
      setReadiness(next);
    } catch (error) {
      if (version === request.current) {
        setCampaigns([]);
        setLoadError(`Failed to load campaigns: ${(error as { message?: string }).message ?? "Unknown query error"}`);
      }
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  // Which campaigns have a planner running right now. Taken from the job queue
  // rather than local state so it survives a reload and is still right when the
  // planner was started from somewhere else.
  const planning = new Set(
    inFlight.filter((j) => j.agent_key === "campaign_plan").map((j) => j.input_id),
  );

  /**
   * Start the planner on a campaign that has no plan.
   *
   * New Campaign queues this at creation, but a campaign can arrive without
   * ever having been planned — seeded, created through the gateway, or left
   * behind by a planner run that failed. Until now those were unrecoverable:
   * the panel had nothing to show and no way to ask for it.
   */
  const plan = async (campaign: Campaign) => {
    if (!clientId) {
      setProblem("No client selected.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const { error } = await supabase.rpc("enqueue_agent_job", {
      p_agent_key: "campaign_plan",
      p_client_id: clientId,
      p_input_table: "client_campaigns",
      p_input_id: campaign.id,
    });
    setBusy(false);
    if (error) {
      // Names the missing upstream intelligence when that is the reason.
      setProblem(error.message);
      return;
    }
    setNotice(`Queued. The planner is writing "${campaign.name}" now.`);
    void refresh();
  };

  /**
   * Build one named thing this campaign needs.
   *
   * "Build what it needs" could not say what it was about to do, and built a
   * sales agent nobody had asked for as a side effect of wanting a page.
   */
  const build = async (campaign: Campaign, kind: "landing_page" | "sales_agent") => {
    setBusy(true);
    setProblem(null);
    const { data, error } = await supabase.rpc("provision_campaign_artifact", {
      p_campaign_id: campaign.id,
      p_kind: kind,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    const created = Array.isArray(data) ? (data[0] as { created?: string } | undefined)?.created : undefined;
    const label = kind === "landing_page" ? "landing page" : "sales agent";
    setNotice(
      created === "already_exists"
        ? `This campaign already has a ${label}. Nothing new was created.`
        : `Building the ${label}. It appears under ${kind === "landing_page" ? "Page Builder" : "Sales Agents"} when the agent finishes.`,
    );
    void refresh();
  };

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

      {readinessError && <p role="alert">{readinessError}</p>}
      {loadError ? <p role="alert">{loadError}</p> : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaigns.length === 0 ? (
        <EmptyState label="No campaigns yet" />
      ) : (
        <div className="space-y-4">
          {campaigns.map((c) => {
            const reqs = readiness[c.id] ?? [];
            const unmet = reqs.filter((r) => !r.met);
            const ready = reqs.length > 0 && unmet.length === 0;
            const isPlanning = planning.has(c.id);

            return (
              <div key={c.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {/* The whole heading toggles, not a chevron nobody can hit. */}
                  {/* h3 wraps the button so the campaign name stays a
                      heading. A heading inside a button would be invalid: a
                      button may only contain phrasing content. */}
                  <h3 className="min-w-0 flex-1">
                  <button
                    type="button"
                    aria-expanded={expanded.has(c.id)}
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    className="flex w-full items-start gap-2 rounded text-left text-sm font-semibold text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        expanded.has(c.id) && "rotate-90",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block">{c.name}</span>
                      <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                        {c.objective ?? c.brief}
                      </span>
                    </span>
                  </button>
                  </h3>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                      STATUS_TONE[c.status] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {c.status}
                  </span>
                </div>

                {!expanded.has(c.id) ? null : c.built_at ? (
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
                    {isPlanning
                      ? "The planner is writing this now."
                      : "Waiting for the planner to write this."}
                  </p>
                )}

                {/* Collapsed still says where the campaign stands. Triaging a
                    list of fifteen must not require opening all fifteen.
                    Built as one string: two expressions in one element become
                    two text nodes, which no text matcher can see as a
                    sentence. */}
                {!expanded.has(c.id) && (
                  <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    {[
                      c.built_at
                        ? "Planned."
                        : isPlanning
                          ? "The planner is writing this now."
                          : "Waiting for the planner to write this.",
                      unmet.length > 0
                        ? `${unmet.length} thing${unmet.length === 1 ? "" : "s"} still missing`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}

                {expanded.has(c.id) && (
                <div className="mt-3 border-t border-border pt-3">
                  <h4 className="text-xs font-semibold text-foreground">Before this can launch</h4>
                  {reqs.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">Readiness unavailable.</p>
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
                )}

                {expanded.has(c.id) && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {!c.built_at && (
                    <button
                      type="button"
                      disabled={busy || isPlanning}
                      onClick={() => void plan(c)}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {isPlanning ? "Planning…" : "Run the planner"}
                    </button>
                  )}
                  <button type="button"
                    aria-expanded={contentCampaignId === c.id}
                    onClick={() => setContentCampaignId(contentCampaignId === c.id ? null : c.id)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >Content production</button>
                  {c.built_at && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void build(c, "landing_page")}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Build landing page
                    </button>
                  )}
                  {/* Optional on purpose: a campaign can be given an agent after
                      planning without re-planning it. */}
                  {c.built_at && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void build(c, "sales_agent")}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Build sales agent
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
                )}
                {contentCampaignId === c.id && clientId && <CampaignContentPanel key={`${clientId}:${c.id}`} clientId={clientId} campaignId={c.id} contentCount={c.content_count} builtAt={c.built_at} contentIdeasGeneratedAt={c.content_ideas_generated_at} onChanged={refresh} refreshToken={campaigns} />}
              </div>
            );
          })}
        </div>
      )}

      <FormModal
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setAiDraft(null);
        }}
        title="New Campaign"
        draftKey={`campaign:${clientId}`}
        intro="Queues the Campaign Planner. It needs your offer strategy and ICP, and writes the plan — including what has to be built before this can run."
        fields={FIELDS}
        submitLabel="Plan it"
        initialValues={aiDraft ?? undefined}
        actions={
          <button
            type="button"
            onClick={() => setProposing(true)}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Generate with AI
          </button>
        }
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
        onSaved={() => {
          setAiDraft(null);
          void refresh();
        }}
      />

      {clientId && (
        <GenerateWithAIDialog<{ name: string; brief: string }>
          open={proposing}
          title="Propose a campaign"
          intro="Everything this business has told us and everything we have worked out about it — the offer, the ICP, the money model, the market and competitor work — is already on file and will be read for you."
          label="Anything to steer it (optional)"
          placeholder="A season, a service to push, a number you are chasing, something a competitor just did. Leave it blank and it will propose whatever the records say is most worth doing."
          footnote="It will not invent a budget, a date or a target. Campaigns you already have are excluded."
          endpoint="/admin/campaigns/draft"
          payload={{ clientId }}
          requireNotes={false}
          onClose={() => setProposing(false)}
          onGenerated={(draft) => {
            // A saved draft wins over initialValues inside FormModal, so a
            // half-typed form would silently swallow the proposal.
            clearDraft(`campaign:${clientId}`);
            setAiDraft(draft);
          }}
        />
      )}
    </div>
  );
}
