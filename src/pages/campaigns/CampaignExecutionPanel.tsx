import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { clearDraft } from "../../components/forms/FormModal";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";
import {
  NO_TEMPLATE,
  templateColumns,
  templateFor,
  templateOptions,
  templateSummary,
} from "../../lib/campaignTemplates";
import { CampaignContentPanel } from "./CampaignContentPanel";
import { MetaBuildSection } from "./MetaBuildSection";
import { ArchiveAction } from "../../components/ArchiveAction";
import { cn } from "../../lib/cn";
import { Modal } from "../../components/Modal";
import { PageBuilderPanel } from "../conversion/PageBuilderPanel";
import { SalesOverviewPanel } from "../sales/SalesOverviewPanel";
import { useCampaignV2Package } from "./useCampaignV2Package";

type Campaign = {
  id: string;
  acquisition_mode: "legacy" | "organic" | "paid";
  paid_platform: "meta" | "google" | null;
  cloned_from_campaign_id: string | null;
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
  ideate_on_plan: boolean;
  launched_at: string | null;
  created_at: string;
  template: string | null;
  mirrors_template: string | null;
  daily_budget: number | null;
  target_countries: string[] | null;
  conversion_event: string | null;
  meta_campaign_id: string | null;
  meta_ad_set_id: string | null;
  meta_built_at: string | null;
  offer_version_id: string | null;
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
  { name: "acquisition_mode", label: "Campaign route", kind: "select", required: true,
    options: [{ value: "organic", label: "Organic" }, { value: "paid", label: "Paid" }],
    hint: "One route per campaign. Clone it to run the same idea through the other route." },
  { name: "paid_platform", label: "Paid platform", kind: "select", required: true,
    showIf: { field: "acquisition_mode", equals: ["paid"] },
    options: [{ value: "meta", label: "Meta Ads" }, { value: "google", label: "Google Ads (planned)" }] },
  {
    name: "template",
    label: "Campaign template (optional)",
    kind: "select",
    showIf: { field: "paid_platform", equals: ["meta"] },
    options: templateOptions(),
    hint: "Fixes the objective, the audience state it aims at and what has to be built, so the planner decides none of those. Leave it blank and the campaign is planned from the brief exactly as before.",
  },
  {
    name: "brief",
    label: "What this campaign is for",
    kind: "textarea",
    rows: 4,
    required: true,
    hint: "The planner writes the objective, audience, message, channels and what has to be built, from this plus your offer strategy and ICP.",
  },
  {
    name: "ideate_on_plan",
    label: "Generate content ideas with this plan",
    kind: "toggle",
    placeholder: "On — generate ideas now. Turn off to plan the campaign and generate ideas later.",
  },
];

const STATUS_TONE: Record<string, string> = {
  planning: "bg-secondary text-secondary-foreground",
  live: "bg-primary/10 text-brand-strong",
  complete: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50";

function productionStage(campaign: Campaign, checks: Requirement[], isPlanning: boolean): string {
  if (campaign.status === "live") return "Live";
  if (campaign.status === "complete" || campaign.status === "cancelled") return campaign.status;
  if (!campaign.built_at) return isPlanning ? "Planning" : "Awaiting plan";
  if (campaign.content_count === 0) return "Plan ready";
  if (campaign.content_count > 0 && !campaign.content_ideas_generated_at) return "Awaiting ideas";
  const content = checks.find((check) => check.requirement.toLowerCase() === "content");
  if (content?.met) return "Content ready";
  if (content && content.have > 0) return "Content in review";
  return "Content production";
}

export function CampaignExecutionPanel() {
  const { clientId, campaignId } = useParams<{ clientId: string; campaignId?: string }>();
  const [searchParams] = useSearchParams();
  const v2 = searchParams.get("view") === "v2";
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [readiness, setReadiness] = useState<Record<string, Requirement[]>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<Campaign | null>(null);
  const [planIdeaChoices, setPlanIdeaChoices] = useState<Record<string, boolean>>({});
  const [proposing, setProposing] = useState(false);
  // The dialog's own pick, kept here so the generated draft can carry it into
  // the form. The endpoint steers by it but does not echo it back.
  const [proposeTemplate, setProposeTemplate] = useState("");
  // Content pillars are useful in either route; route choice is immutable.
  const [pillars, setPillars] = useState<{ id: string; name: string; target_share: number }[]>([]);
  const [pillarsFailed, setPillarsFailed] = useState(false);
  const [chosenPillars, setChosenPillars] = useState<string[]>([]);
  const [approvedOfferChoices, setApprovedOfferChoices] = useState<{ id: string; label: string }[]>([]);
  const [offersFailed, setOffersFailed] = useState(false);
  const chosenTemplate = templateFor(proposeTemplate);
  // template is not part of what the endpoint returns — it is the operator's
  // own pick, carried through so the form opens on it.
  const [aiDraft, setAiDraft] = useState<
    { name: string; brief: string; template?: string } | null
  >(null);
  const newCampaignValues = useMemo(() => ({
    ...aiDraft,
    ...(aiDraft?.template ? { acquisition_mode: "paid", paid_platform: "meta" } : {}),
    ideate_on_plan: true,
  }), [aiDraft]);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [editingPlan, setEditingPlan] = useState<Campaign | null>(null);
  const [metaToolsOpenFor, setMetaToolsOpenFor] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [rowActions, setRowActions] = useState<string | null>(null);
  const [v2TabSelection, setV2TabSelection] = useState({ campaignId, tab: "plan" });
  const v2Tab = v2TabSelection.campaignId === campaignId ? v2TabSelection.tab : "plan";
  const metaToolsOpen = metaToolsOpenFor === campaignId;
  const [confirmAction, setConfirmAction] = useState<{ campaign: Campaign; kind: "archive" | "delete" | "plan" | "launch" | "clone" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const request = useRef(0);
  const packageState = useCampaignV2Package(clientId, campaignId, v2 && Boolean(campaignId));

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
      const query = supabase
        .from("client_campaigns")
        .select(
          "id, name, brief, status, objective, audience, offer_summary, core_message, channels, budget, starts_on, ends_on, kpi_metric, kpi_target, content_count, needs_landing_page, needs_sales_agent, built_at, content_ideas_generated_at, ideate_on_plan, launched_at, created_at, template, mirrors_template, daily_budget, target_countries, conversion_event, meta_campaign_id, meta_ad_set_id, meta_built_at, acquisition_mode, paid_platform, cloned_from_campaign_id, offer_version_id",
        )
        .eq("client_id", clientId)
        // A campaign somebody archived is over. It reads from the archive.
        .is("archived_at", null);
      const { data, error } = await (campaignId ? query.eq("id", campaignId) : query)
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
  }, [clientId, campaignId]);

  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [refresh]);

  // Active pillars, loaded when the form opens rather than on every render.
  useEffect(() => {
    if (!newOpen || !clientId) return;
    let cancelled = false;
    setPillarsFailed(false);
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("client_content_pillars")
          .select("id, name, target_share")
          .eq("client_id", clientId)
          .eq("active", true)
          .order("target_share", { ascending: false });
        if (cancelled) return;
        // A failed load must not render as "this client has no pillars".
        // Somebody would plan a campaign without them believing there were
        // none to pick, and nothing would ever say otherwise.
        if (error) {
          setPillarsFailed(true);
          setPillars([]);
          return;
        }
        setPillars(data ?? []);
      } catch {
        if (!cancelled) {
          setPillarsFailed(true);
          setPillars([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [newOpen, clientId]);

  useEffect(() => {
    if ((!newOpen && !editingPlan) || !clientId) return;
    let cancelled = false;
    setOffersFailed(false);
    void (async () => {
      const [offers, versions, signoffs] = await Promise.all([
        supabase.from("service_offers").select("id, service_name").eq("client_id", clientId),
        supabase.from("service_offer_versions").select("id, offer_id, version, promise").eq("client_id", clientId),
        supabase.from("service_offer_signoffs").select("offer_version_id").eq("client_id", clientId),
      ]);
      if (cancelled) return;
      if (offers.error || versions.error || signoffs.error) {
        setOffersFailed(true);
        setApprovedOfferChoices([]);
        return;
      }
      const signed = new Set((signoffs.data ?? []).map((row) => row.offer_version_id));
      const names = new Map((offers.data ?? []).map((row) => [row.id, row.service_name]));
      setApprovedOfferChoices((versions.data ?? [])
        .filter((row) => signed.has(row.id))
        .map((row) => ({ id: row.id,
          label: `${names.get(row.offer_id) ?? "Service"} v${row.version} · ${row.promise.slice(0, 90)}` })));
    })().catch(() => { if (!cancelled) setOffersFailed(true); });
    return () => { cancelled = true; };
  }, [newOpen, editingPlan, clientId]);

  const { inFlight, recentFailures } = useAgentJobs(clientId, () => {
    void refresh();
    void packageState.refresh();
  });

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
    const ideate = planIdeaChoices[campaign.id] ?? campaign.ideate_on_plan ?? true;
    if (ideate !== (campaign.ideate_on_plan ?? true)) {
      const { error: updateError } = await supabase.from("client_campaigns")
        .update({ ideate_on_plan: ideate }).eq("id", campaign.id).eq("client_id", clientId);
      if (updateError) { setBusy(false); setProblem(updateError.message); return; }
    }
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

  /**
   * Remove a campaign and the content produced for it.
   *
   * Pattern A: the RPC deletes owned ideas, content briefs and assets
   * intentionally, then the campaign. CASCADE also clears artifact and pillar
   * links. Landing pages and sales agents stay; only their campaign links go.
   * Confirm copy must name that scope — a silent cascade is how somebody
   * deletes twelve ideas by accident.
   */
  const deleteCampaign = async (campaign: Campaign, confirmed = false) => {
    const warning =
      `Delete "${campaign.name}"? This also deletes its campaign ideas, ` +
      `content briefs and generated assets. Landing pages and sales agents ` +
      `stay, but their link to this campaign is removed. It cannot be undone.`;
    if (!confirmed && !window.confirm(warning)) return;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const { data, error } = await supabase.rpc("delete_client_campaign", {
      p_campaign_id: campaign.id,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    const row = Array.isArray(data) ? data[0] : null;
    const ideas = row?.deleted_ideas ?? 0;
    const briefs = row?.deleted_briefs ?? 0;
    const assets = row?.deleted_assets ?? 0;
    const parts = [
      ideas > 0 ? `${ideas} idea${ideas === 1 ? "" : "s"}` : null,
      briefs > 0 ? `${briefs} brief${briefs === 1 ? "" : "s"}` : null,
      assets > 0 ? `${assets} asset${assets === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    setNotice(
      parts.length > 0
        ? `Deleted "${campaign.name}", along with ${parts.join(", ")}.`
        : `Deleted "${campaign.name}".`,
    );
    if (campaignId) navigate(`/clients/${clientId}/delivery/campaign-factory${v2 ? "?view=v2" : ""}`);
    else void refresh();
  };

  /** A planned campaign can have approved creative and an immutable v6 package.
   * Regeneration therefore makes a linked revision and preserves the source. */
  const createPlanRevision = async (campaign: Campaign, brief: string, changes?: { template: string; offerVersionId: string | null }) => {
    if (!clientId) throw new Error("No client selected.");
    if (changes && offersFailed) throw new Error("Approved offers could not be loaded.");
    if (changes?.offerVersionId && !approvedOfferChoices.some((offer) => offer.id === changes.offerVersionId))
      throw new Error("Choose an approved offer belonging to this client.");
    const nextTemplate = changes?.template ?? campaign.template;
    if (nextTemplate && !templateFor(nextTemplate)) throw new Error("Choose a valid campaign template.");
    const { data, error } = await supabase.from("client_campaigns").insert({
      client_id: clientId,
      name: `${campaign.name.slice(0, 165)} · Plan revision ${new Date().toISOString().slice(0, 10)}`,
      brief,
      acquisition_mode: campaign.acquisition_mode,
      paid_platform: campaign.paid_platform,
      cloned_from_campaign_id: campaign.id,
      offer_version_id: changes ? changes.offerVersionId : campaign.offer_version_id,
      ideate_on_plan: campaign.ideate_on_plan,
      ...(nextTemplate ? templateColumns(nextTemplate) ?? {} : {}),
    }).select("id").single();
    if (error) throw error;
    // A revision must carry the same selected pillars into its new plan.
    // Otherwise the planner silently changes the creative scope.
    const selected = await supabase.from("campaign_content_pillars")
      .select("pillar_id").eq("campaign_id", campaign.id);
    if (selected.error) throw selected.error;
    if (selected.data?.length) {
      const copied = await supabase.from("campaign_content_pillars").insert(
        selected.data.map(({ pillar_id }) => ({ campaign_id: data.id, pillar_id })),
      );
      if (copied.error) throw copied.error;
    }
    const queued = await supabase.rpc("enqueue_agent_job", {
      p_agent_key: "campaign_plan", p_client_id: clientId,
      p_input_table: "client_campaigns", p_input_id: data.id,
    });
    if (queued.error) throw queued.error;
    navigate(`/clients/${clientId}/delivery/campaign-factory/${data.id}?view=v2`);
  };

  const runConfirmedAction = async () => {
    if (!confirmAction || !clientId) return;
    const { campaign, kind } = confirmAction;
    setConfirmAction(null);
    setActionsOpen(false);
    setRowActions(null);
    if (kind === "clone") { setCloneSource(campaign); return; }
    if (kind === "delete") { await deleteCampaign(campaign, true); return; }
    if (kind === "plan") {
      if (campaign.built_at) {
        try { await createPlanRevision(campaign, campaign.brief); }
        catch (error) { setProblem((error as Error).message); }
      } else await plan(campaign);
      return;
    }
    if (kind === "launch") { await act("launch_campaign", campaign, () => `"${campaign.name}" is live.`); return; }
    setBusy(true);
    const { error } = await supabase.from("client_campaigns")
      .update({ archived_at: new Date().toISOString() }).eq("id", campaign.id).eq("client_id", clientId);
    setBusy(false);
    if (error) setProblem(error.message);
    else if (campaignId) navigate(`/clients/${clientId}/delivery/campaign-factory?view=v2`);
    else { setNotice(`Archived "${campaign.name}".`); void refresh(); }
  };

  const visibleCampaigns = campaignId ? campaigns.filter((campaign) => campaign.id === campaignId) : campaigns;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      {campaignId && clientId && <Link to={`/clients/${clientId}/delivery/campaign-factory${v2 ? "?view=v2" : ""}`} className="mb-4 inline-block text-sm text-brand-strong hover:underline">← All campaigns</Link>}
      {!campaignId && <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setNewOpen(true)}>
          New Campaign
        </Button>
      </div>}

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
      ) : visibleCampaigns.length === 0 ? (
        <EmptyState label={campaignId ? "Campaign not found" : "No campaigns yet"} />
      ) : v2 ? (
        campaignId ? visibleCampaigns.map((c) => {
          const reqs = readiness[c.id] ?? [];
          const ready = reqs.length > 0 && reqs.every((requirement) => requirement.met);
          const launchAvailable = c.status !== "live" && c.acquisition_mode === "legacy" && ready;
          const paid = c.acquisition_mode === "paid";
          const tabs = paid ? [ ["plan", "Plan"], ["content", "Content"], ["landing-page", "Landing Page"], ["sales-agent", "Sales Agent"], ...(c.paid_platform === "meta" ? [["meta-ads", "Meta Ads"]] as const : []) ] as const : [ ["plan", "Plan"], ["content", "Content"] ] as const;
          return <div key={c.id}>
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-3"><h2 className="text-lg font-semibold">{c.name}</h2><span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_TONE[c.status] ?? "bg-muted text-muted-foreground")}>{c.status}</span></div>
                  <p className="mt-1 text-xs text-muted-foreground">{c.acquisition_mode === "paid" ? `Paid · ${c.paid_platform === "meta" ? "Meta Ads" : "Google Ads"}` : c.acquisition_mode === "organic" ? "Organic" : "Legacy campaign"}
                    {c.cloned_from_campaign_id && <>{" · "}<Link className="text-brand-strong underline" to={`/clients/${clientId}/delivery/campaign-factory/${c.cloned_from_campaign_id}?view=v2`}>Source campaign</Link></>}
                  </p></div>
                <button type="button" className={buttonClass} onClick={() => setEditing(c)}>Edit campaign</button>
              </div>
              <dl className="mt-4 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div><dt className="text-muted-foreground">Brief</dt><dd className="whitespace-pre-wrap">{c.brief}</dd></div>
                <div><dt className="text-muted-foreground">Objective</dt><dd>{c.objective ?? "Awaiting plan"}</dd></div>
                <div><dt className="text-muted-foreground">Offer</dt><dd>{c.offer_summary ?? "—"}</dd></div>
                <div><dt className="text-muted-foreground">Budget</dt><dd>{c.budget == null ? "—" : c.budget.toLocaleString()}</dd></div>
                <div><dt className="text-muted-foreground">Template</dt><dd>{c.template ?? "—"}</dd></div>
                <div><dt className="text-muted-foreground">Dates</dt><dd>{c.starts_on ?? "—"} to {c.ends_on ?? "—"}</dd></div>
              </dl>
            </section>
            <section className="mt-4 rounded-lg border border-border bg-card p-4" aria-label="Readiness and blockers">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Readiness and blockers</h3><button type="button" className={buttonClass} onClick={() => { void refresh(); void packageState.refresh(); }}>Refresh status</button></div>
              {packageState.error && <p role="alert" className="mt-2 text-xs text-destructive">Package status unavailable: {packageState.error}</p>}
              {packageState.loading && <p className="mt-2 text-xs text-muted-foreground">Loading package…</p>}
              {packageState.manifest ? <p className="mt-2 text-xs text-muted-foreground">Package v{packageState.manifest.version} · created {new Date(packageState.manifest.created_at).toLocaleString()} · plan hash {packageState.manifest.plan_hash.slice(0, 12)}… Content and approvals must be checked against this version.</p>
                : c.acquisition_mode !== "legacy" && !packageState.loading && <p className="mt-2 text-xs text-muted-foreground">No versioned package yet. Run the planner to create one.</p>}
              {packageState.items.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Package scope: {packageState.items.filter((item) => item.required).map((item) => item.item_key.replaceAll("_", " ")).join(", ")}. These are planned dependencies, not completed work.</p>}
              {reqs.length ? <><p className="mt-3 text-xs font-medium">Artifact checks</p><ul className="mt-1 space-y-1">{reqs.map((r) => <li key={r.requirement} className="flex gap-2 text-xs"><span className={r.met ? "text-brand-strong" : "text-destructive"}>{r.met ? "●" : "○"}</span><span className="font-medium">{r.requirement}</span><span className="text-muted-foreground">{r.detail}</span></li>)}</ul></>
                : <p className="mt-2 text-xs text-muted-foreground">Artifact readiness is unavailable; launch cannot be assessed.</p>}
              {packageState.manifest && <p className="mt-3 text-xs text-muted-foreground">New content links record the campaign package active when linked. Older links are marked as not version-bound; review the exact asset before requesting external approval.</p>}
              {packageState.approvals.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Current-package approvals: {packageState.approvals.map((approval) => `${approval.action_key.replaceAll("_", " ")} · ${approval.status}`).join("; ")}</p>}
            </section>
            <div className="relative mt-4">
              <Button onClick={() => setActionsOpen((open) => !open)}>Action buttons</Button>
              {actionsOpen && <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-border bg-card p-3" aria-label="Campaign actions">
                {(["archive", "delete", "plan", "launch", "clone"] as const).map((kind) => <button key={kind} type="button" className={buttonClass} disabled={busy || (kind === "launch" && !launchAvailable) || (kind === "plan" && planning.has(c.id))} onClick={() => setConfirmAction({ campaign: c, kind })}>{kind === "plan" ? "Run planner" : kind === "clone" ? "Clone to another route" : kind[0].toUpperCase() + kind.slice(1)}</button>)}
                {!launchAvailable && c.status !== "live" && <p className="w-full text-xs text-muted-foreground">Launch requires a ready legacy campaign. New routes require version-bound human approval.</p>}
              </div>}
            </div>
            <div className="mt-6 flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Campaign sections">
              {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={v2Tab === id} onClick={() => setV2TabSelection({ campaignId, tab: id })} className={cn("border-b-2 px-4 py-2 text-sm", v2Tab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>)}
            </div>
            {v2Tab === "plan" && <section className="space-y-4 py-4" aria-label="Campaign plan">
              <div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold">Campaign plan</h3><p className="text-xs text-muted-foreground">{c.built_at ? `Generated ${new Date(c.built_at).toLocaleString()}` : "Awaiting planner"}</p></div><div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => setEditingPlan(c)}>Edit plan</button><button type="button" className={buttonClass} disabled={busy || planning.has(c.id)} onClick={() => setConfirmAction({ campaign: c, kind: "plan" })}>{c.built_at ? "Regenerate plan" : "Run planner"}</button></div></div>
              <dl className="grid gap-4 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Objective</dt><dd>{c.objective ?? "—"}</dd></div><div><dt className="text-muted-foreground">Audience</dt><dd>{c.audience ?? "—"}</dd></div><div><dt className="text-muted-foreground">Offer</dt><dd>{c.offer_summary ?? "—"}</dd></div><div><dt className="text-muted-foreground">Core message</dt><dd>{c.core_message ?? "—"}</dd></div><div><dt className="text-muted-foreground">Channels</dt><dd>{c.channels?.join(", ") || "—"}</dd></div><div><dt className="text-muted-foreground">Budget</dt><dd>{c.budget == null ? "—" : c.budget.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">Dates</dt><dd>{c.starts_on ?? "—"} to {c.ends_on ?? "—"}</dd></div><div><dt className="text-muted-foreground">KPI</dt><dd>{c.kpi_metric ?? "—"}{c.kpi_target != null ? ` · target ${c.kpi_target}` : ""}</dd></div><div><dt className="text-muted-foreground">Content pieces</dt><dd>{c.content_count}</dd></div><div><dt className="text-muted-foreground">Required builds</dt><dd>{[c.needs_landing_page && "Landing page", c.needs_sales_agent && "Sales agent"].filter(Boolean).join(", ") || "None"}</dd></div></dl>
            </section>}
            {v2Tab === "content" && clientId && <CampaignContentPanel key={`${clientId}:${c.id}:v2`} clientId={clientId} campaignId={c.id} contentCount={c.content_count} builtAt={c.built_at} contentIdeasGeneratedAt={c.content_ideas_generated_at} template={c.template} mirrorsTemplate={c.mirrors_template} onChanged={refresh} refreshToken={campaigns} layout="v2" />}
            {paid && v2Tab === "landing-page" && clientId && <PageBuilderPanel key={c.id} clientId={clientId} campaignId={c.id} campaignName={c.name} />}
            {paid && v2Tab === "sales-agent" && <SalesOverviewPanel key={c.id} campaignId={c.id} campaignName={c.name} />}
            {paid && c.paid_platform === "meta" && v2Tab === "meta-ads" && clientId && <section className="py-4"><div className="rounded-lg border border-border bg-card p-4 text-sm"><h3 className="font-semibold">Meta activation</h3><p className="mt-2 text-xs text-muted-foreground">{packageState.manifest ? `Current package v${packageState.manifest.version}. ` : "A planned package is required. "}{packageState.approvals.filter((approval) => approval.action_key === "meta_ad_build").map((approval) => `Meta ad build approval: ${approval.status}. `).join("") || "No Meta build approval is recorded for this package. "}Prepare the build sheet and approved creative here. Creating Meta objects still awaits the exact-version approval executor.</p><Link className="mt-2 inline-block text-xs text-brand-strong underline" to={`/clients/${clientId}/delivery/approval-inbox?tab=campaign-actions`}>Open Approval Inbox</Link>{c.meta_campaign_id && <p className="mt-2 text-xs">Meta campaign {c.meta_campaign_id}{c.meta_ad_set_id ? ` · ad set ${c.meta_ad_set_id}` : " · ad set pending"}{c.meta_built_at ? ` · recorded ${new Date(c.meta_built_at).toLocaleString()}` : ""}</p>}</div><div className="mt-3 flex justify-end"><Button onClick={() => setMetaToolsOpenFor((open) => open === c.id ? null : c.id)}>Build functionality</Button></div>{metaToolsOpen && <MetaBuildSection clientId={clientId} campaign={c} building={inFlight.some((job) => job.agent_key === "meta_build" && job.input_id === c.id)} onChanged={() => { void refresh(); void packageState.refresh(); }} externalActionsAvailable={false} handBuildAvailable showSheetInline />}</section>}
          </div>;
        }) : <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm"><thead className="border-b border-border bg-muted/40"><tr><th className="p-3">Campaign</th><th className="p-3">Route</th><th className="p-3">Type</th><th className="p-3">Date</th><th className="p-3">Status</th><th className="p-3">Production stage</th><th className="p-3">Edit</th></tr></thead><tbody>{visibleCampaigns.map((c) => <tr key={c.id} className="border-b border-border last:border-0"><td className="p-3"><Link className="font-medium text-brand-strong hover:underline" to={`/clients/${clientId}/delivery/campaign-factory/${c.id}?view=v2`}>{c.name}</Link>{c.cloned_from_campaign_id && <span className="block text-xs text-muted-foreground">Revised or cloned from another campaign</span>}</td><td className="p-3">{c.acquisition_mode === "paid" ? `Paid · ${c.paid_platform === "meta" ? "Meta" : "Google"}` : c.acquisition_mode === "organic" ? "Organic" : "Legacy"}</td><td className="p-3">{c.acquisition_mode === "organic" ? "Organic" : c.acquisition_mode === "paid" ? "Paid" : "Not specified"}</td><td className="p-3">{new Date(c.created_at).toLocaleDateString()}</td><td className="p-3 capitalize">{c.status}</td><td className="p-3">{productionStage(c, readiness[c.id] ?? [], planning.has(c.id))}</td><td className="p-3"><button type="button" className={buttonClass} aria-expanded={rowActions === c.id} onClick={() => setRowActions(rowActions === c.id ? null : c.id)}>Edit</button>{rowActions === c.id && <div className="mt-2 flex gap-2"><button type="button" className={buttonClass} onClick={() => setConfirmAction({ campaign: c, kind: "archive" })}>Archive</button><button type="button" className={buttonClass} onClick={() => setConfirmAction({ campaign: c, kind: "delete" })}>Delete</button></div>}</td></tr>)}</tbody></table></div>
      ) : (
        <div className="space-y-4">
          {visibleCampaigns.map((c) => {
            const reqs = readiness[c.id] ?? [];
            const unmet = reqs.filter((r) => !r.met);
            const ready = reqs.length > 0 && unmet.length === 0;
            const isPlanning = planning.has(c.id);

            return (
              <div key={c.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1">
                  {campaignId ? <span className="flex w-full items-start gap-2 text-lg font-semibold text-card-foreground">{c.name}</span> : <Link
                    to={`/clients/${clientId}/delivery/campaign-factory/${c.id}`}
                    className="flex w-full items-start gap-2 rounded text-left text-sm font-semibold text-card-foreground hover:text-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block">{c.name}</span>
                      <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                        {c.objective ?? c.brief}
                      </span>
                    </span>
                  </Link>}
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

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded border border-border px-2 py-0.5 font-medium capitalize text-foreground">
                    {c.acquisition_mode === "paid"
                      ? `Paid · ${c.paid_platform === "google" ? "Google Ads" : "Meta Ads"}`
                      : c.acquisition_mode === "organic" ? "Organic" : "Legacy route · clone for v6"}
                  </span>
                  {c.cloned_from_campaign_id && <Link className="text-brand-strong underline"
                    to={`/clients/${clientId}/delivery/campaign-factory/${c.cloned_from_campaign_id}`}>
                    Source campaign
                  </Link>}
                </div>

                {campaignId && <dl className="mt-4 grid gap-3 border-t border-border pt-3 text-xs sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">Brief</dt><dd className="whitespace-pre-wrap text-card-foreground">{c.brief}</dd></div>
                  <div><dt className="text-muted-foreground">Objective</dt><dd className="text-card-foreground">{c.objective ?? "Awaiting plan"}</dd></div>
                  <div><dt className="text-muted-foreground">Offer</dt><dd className="text-card-foreground">{c.offer_summary ?? "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Budget</dt><dd className="text-card-foreground">{c.budget == null ? "—" : c.budget.toLocaleString()}</dd></div>
                  <div><dt className="text-muted-foreground">Dates</dt><dd className="text-card-foreground">{c.starts_on ?? "—"} to {c.ends_on ?? "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Template</dt><dd className="text-card-foreground">{c.template ?? "—"}</dd></div>
                </dl>}

                {!campaignId ? null : c.built_at ? (
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

                {!campaignId && (
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

                {campaignId && (
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

                {campaignId && clientId && (c.acquisition_mode === "legacy"
                  || (c.acquisition_mode === "paid" && c.paid_platform === "meta")) && (
                  <MetaBuildSection
                    clientId={clientId}
                    campaign={c}
                    building={inFlight.some((j) => j.agent_key === "meta_build" && j.input_id === c.id)}
                    onChanged={() => void refresh()}
                    externalActionsAvailable={c.acquisition_mode === "legacy"}
                  />
                )}

                {campaignId && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <button type="button" disabled={busy} onClick={() => setCloneSource(c)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50">
                    Clone to another route
                  </button>
                  {!c.built_at && (
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input type="checkbox" checked={planIdeaChoices[c.id] ?? c.ideate_on_plan ?? true}
                        onChange={(event) => setPlanIdeaChoices((current) => ({ ...current, [c.id]: event.target.checked }))}
                        disabled={busy || isPlanning} /> Generate content ideas with this plan
                    </label>
                  )}
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
                  {c.status !== "live" && c.acquisition_mode === "legacy" && (
                    <button
                      type="button"
                      disabled={busy || !ready}
                      onClick={() => void act("launch_campaign", c, () => `"${c.name}" is live.`)}
                      className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Launch
                    </button>
                  )}
                  {c.status !== "live" && c.acquisition_mode !== "legacy" && (
                    <span className="text-xs text-muted-foreground">
                      External activation waits for version-bound human approval.
                    </span>
                  )}
                  {!ready && c.status !== "live" && unmet.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {unmet.length} thing{unmet.length === 1 ? "" : "s"} still missing
                    </span>
                  )}
                  {/* Nothing infers that a campaign is over — an end date
                      that passed while it was paused is not a finished
                      campaign — so the person who knows says so here. */}
                  <ArchiveAction
                    table="client_campaigns"
                    id={c.id}
                    archived={false}
                    noun="campaign"
                    onDone={() => navigate(`/clients/${clientId}/delivery/campaign-factory`)}
                    onError={setProblem}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteCampaign(c)}
                    aria-label={`Delete ${c.name}`}
                    className="inline-flex items-center gap-1 rounded text-xs text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </button>
                </div>
                )}
                {campaignId && clientId && <CampaignContentPanel key={`${clientId}:${c.id}`} clientId={clientId} campaignId={c.id} contentCount={c.content_count} builtAt={c.built_at} contentIdeasGeneratedAt={c.content_ideas_generated_at} template={c.template} mirrorsTemplate={c.mirrors_template} onChanged={refresh} refreshToken={campaigns} />}
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
        intro="Queues the Campaign Planner. Select an approved service offer to bind its exact version to the plan and package. The planner needs the ICP and uses the client-wide offer strategy when no offer is selected."
        fields={[...FIELDS, { name: "offer_version_id", label: "Approved service offer (optional)",
          kind: "select", options: approvedOfferChoices.map((offer) => ({ value: offer.id, label: offer.label })),
          hint: "The selected version is fixed for this campaign. Leave empty to use the client-wide offer strategy." } as FieldDef]}
        extra={
          offersFailed ? <p role="alert" className="text-sm text-destructive">
            Approved offers could not be loaded. Try again before planning this campaign.
          </p> : pillarsFailed ? (
            <p role="alert" className="rounded-md border border-border p-3 text-sm text-destructive">
              Could not load this client&apos;s content pillars, so none can be picked. The campaign can
              still be planned without them.
            </p>
          ) : pillars.length > 0 ? (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium text-card-foreground">
                Content pillars (optional)
              </legend>
              <p className="mb-2 text-xs text-muted-foreground">
                Every piece this campaign plans will sit in one of the pillars you pick. Leave them all
                unticked and it plans without pillars, as before.
              </p>
              <div className="space-y-1.5">
                {pillars.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={chosenPillars.includes(p.id)}
                      onChange={(e) =>
                        setChosenPillars((current) =>
                          e.target.checked
                            ? [...current, p.id]
                            : current.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <span>
                      {p.name}{" "}
                      <span className="text-muted-foreground">· {p.target_share}% of the calendar</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null
        }
        submitLabel="Plan it"
        initialValues={newCampaignValues}
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
          if (offersFailed) throw new Error("Approved offers could not be loaded.");
          if (v.offer_version_id && !approvedOfferChoices.some((offer) => offer.id === v.offer_version_id))
            throw new Error("Choose an approved offer belonging to this client.");
          const acquisitionMode = v.acquisition_mode;
          const paidPlatform = acquisitionMode === "paid" ? v.paid_platform : null;
          if (acquisitionMode !== "organic" && acquisitionMode !== "paid")
            throw new Error("Choose an organic or paid route.");
          if (acquisitionMode === "paid" && paidPlatform !== "meta" && paidPlatform !== "google")
            throw new Error("Choose Meta Ads or Google Ads for this paid campaign.");
          const { data, error } = await supabase
            .from("client_campaigns")
            .insert({
              client_id: clientId,
              name: (v.name as string).trim(),
              brief: (v.brief as string).trim(),
              acquisition_mode: acquisitionMode,
              paid_platform: paidPlatform as "meta" | "google" | null,
              offer_version_id: (v.offer_version_id as string) || null,
              ideate_on_plan: v.ideate_on_plan !== false,
              // Spread only when a template was picked. The columns arrive in
              // migration 96, and a campaign planned without a template must
              // keep working on a database that does not have them yet.
              ...(acquisitionMode === "paid" && paidPlatform === "meta"
                ? templateColumns(v.template as string) ?? {} : {}),
            })
            .select("id")
            .single();
          if (error) throw error;

          if (chosenPillars.length > 0) {
            const { error: pillarError } = await supabase.from("campaign_content_pillars").insert(
              chosenPillars.map((pillar_id) => ({ campaign_id: data.id, pillar_id })),
            );
            // Fail before queueing. A campaign planned without the pillars
            // somebody chose would generate the wrong content and look right.
            if (pillarError) throw new Error(pillarError.message);
          }

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
          setChosenPillars([]);
          void refresh();
        }}
      />

      <FormModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit campaign"
        intro={editing?.built_at ? "This plan is versioned. Rename the campaign here; use Edit plan to change its brief, offer, budget, template or dates and generate a new revision." : "Rename or change the brief before the planner runs."}
        fields={[
          { name: "name", label: "Campaign name", kind: "text", required: true },
          ...(!editing?.built_at ? [{ name: "brief", label: "Brief", kind: "textarea", rows: 4, required: true } as FieldDef] : []),
        ]}
        initialValues={editing ? {
          name: editing.name, brief: editing.brief, objective: editing.objective,
          offer_summary: editing.offer_summary, budget: editing.budget?.toString() ?? "",
          template: editing.template, starts_on: editing.starts_on, ends_on: editing.ends_on,
        } : undefined}
        onSubmit={async (values) => {
          if (!editing || !clientId) throw new Error("No campaign selected.");
          const name = String(values.name ?? "").trim();
          const brief = editing.built_at ? editing.brief : String(values.brief ?? "").trim();
          if (!name || !brief) throw new Error("Name and brief are required.");
          const { error } = await supabase.from("client_campaigns").update({
            name, ...(!editing.built_at ? { brief } : {}),
          }).eq("id", editing.id).eq("client_id", clientId);
          if (error) throw error;
        }}
        onSaved={() => { setEditing(null); setNotice("Campaign updated."); void refresh(); }}
      />

      <FormModal
        open={editingPlan !== null}
        onClose={() => setEditingPlan(null)}
        title="Edit and regenerate plan"
        intro="Saving creates a new campaign revision and asks the planner to apply these directions. Review the generated plan before building; existing assets and approvals stay with the original campaign. Select a different approved offer or Meta template here when that binding must change."
        fields={[
          { name: "brief", label: "Campaign brief", kind: "textarea", rows: 4, required: true },
          ...(editingPlan?.acquisition_mode === "paid" && editingPlan.paid_platform === "meta" ? [{ name: "template", label: "Meta template", kind: "select", options: templateOptions() } as FieldDef] : []),
          { name: "offer_version_id", label: "Approved service offer", kind: "select", options: approvedOfferChoices.map((offer) => ({ value: offer.id, label: offer.label })) },
          { name: "objective", label: "Objective", kind: "textarea", rows: 2 },
          { name: "audience", label: "Audience", kind: "textarea", rows: 2 },
          { name: "offer_summary", label: "Offer", kind: "textarea", rows: 2 },
          { name: "core_message", label: "Core message", kind: "textarea", rows: 2 },
          { name: "channels", label: "Channels (comma separated)", kind: "text" },
          { name: "budget", label: "Budget", kind: "number" },
          { name: "starts_on", label: "Start date", kind: "date" },
          { name: "ends_on", label: "End date", kind: "date" },
          { name: "kpi_metric", label: "KPI", kind: "text" },
          { name: "kpi_target", label: "KPI target", kind: "number" },
          { name: "content_count", label: "Content pieces", kind: "number" },
        ]}
        initialValues={editingPlan ? {
          brief: editingPlan.brief, template: editingPlan.template ?? "", offer_version_id: editingPlan.offer_version_id ?? "", objective: editingPlan.objective, audience: editingPlan.audience,
          offer_summary: editingPlan.offer_summary, core_message: editingPlan.core_message,
          channels: editingPlan.channels?.join(", ") ?? "", budget: editingPlan.budget?.toString() ?? "",
          starts_on: editingPlan.starts_on, ends_on: editingPlan.ends_on,
          kpi_metric: editingPlan.kpi_metric, kpi_target: editingPlan.kpi_target?.toString() ?? "",
          content_count: editingPlan.content_count.toString(),
        } : undefined}
        submitLabel="Save and regenerate"
        onSubmit={async (values) => {
          if (!editingPlan) throw new Error("No campaign selected.");
          const brief = String(values.brief ?? "").trim();
          if (!brief) throw new Error("Campaign brief is required.");
          const planInstructions = [
            ["Objective", values.objective], ["Audience", values.audience],
            ["Offer", values.offer_summary], ["Core message", values.core_message],
            ["Channels", values.channels], ["Budget", values.budget],
            ["Start date", values.starts_on], ["End date", values.ends_on],
            ["KPI", values.kpi_metric], ["KPI target", values.kpi_target],
            ["Content pieces", values.content_count],
          ].filter(([, value]) => String(value ?? "").trim()).map(([label, value]) => `${label}: ${String(value).trim()}`);
          await createPlanRevision(editingPlan, `${brief}\n\nRequested plan direction:\n${planInstructions.join("\n")}`, {
            template: String(values.template ?? editingPlan.template ?? ""),
            offerVersionId: String(values.offer_version_id ?? "") || null,
          });
        }}
        onSaved={() => setEditingPlan(null)}
      />

      <Modal open={confirmAction !== null} onClose={() => setConfirmAction(null)} title="Confirm campaign action">
        {confirmAction && <div className="space-y-4 text-sm">
          <p>{confirmAction.kind === "delete"
            ? `Delete “${confirmAction.campaign.name}” and its campaign ideas, briefs, and generated assets? Linked landing pages and sales agents remain. This cannot be undone.`
            : confirmAction.kind === "archive"
              ? `Archive “${confirmAction.campaign.name}”? You can restore it from Archive.`
              : confirmAction.kind === "plan"
                ? confirmAction.campaign.built_at
                  ? `Regenerate the plan for “${confirmAction.campaign.name}”? This creates a linked revision and preserves the original campaign and its assets.`
                  : `Run the planner for “${confirmAction.campaign.name}”?`
                : confirmAction.kind === "launch"
                  ? `Launch “${confirmAction.campaign.name}”? This changes its status to live.`
                  : `Clone “${confirmAction.campaign.name}” into another route?`}</p>
          <div className="flex justify-end gap-2"><button type="button" className={buttonClass} onClick={() => setConfirmAction(null)}>Cancel</button><Button onClick={() => void runConfirmedAction()}>Continue</Button></div>
        </div>}
      </Modal>

      <FormModal
        open={cloneSource !== null}
        onClose={() => setCloneSource(null)}
        title="Clone campaign into a new route"
        intro="Copies the source brief and starts a separate plan. Creative, approvals, platform IDs and results stay with the original campaign."
        fields={[
          { name: "name", label: "New campaign name", kind: "text", required: true },
          { name: "acquisition_mode", label: "New route", kind: "select", required: true,
            options: [{ value: "organic", label: "Organic" }, { value: "paid", label: "Paid" }] },
          { name: "paid_platform", label: "Paid platform", kind: "select", required: true,
            showIf: { field: "acquisition_mode", equals: ["paid"] },
            options: [{ value: "meta", label: "Meta Ads" }, { value: "google", label: "Google Ads (planned)" }] },
        ]}
        initialValues={cloneSource ? {
          name: `${cloneSource.name} · New route`,
          acquisition_mode: cloneSource.acquisition_mode === "organic" ? "paid" : "organic",
          paid_platform: cloneSource.acquisition_mode === "organic" ? "meta" : "",
        } : undefined}
        submitLabel="Create separate campaign"
        onSubmit={async (v) => {
          if (!cloneSource || !clientId) throw new Error("No source campaign selected.");
          const mode = v.acquisition_mode as string;
          const platform = mode === "paid" ? v.paid_platform as string : null;
          if (mode === cloneSource.acquisition_mode)
            throw new Error("Choose the other route. This clone must be independent.");
          const { data, error } = await supabase.rpc("clone_campaign_for_route", {
            p_source_campaign_id: cloneSource.id,
            p_target_mode: mode,
            p_paid_platform: platform,
            p_name: (v.name as string).trim(),
          });
          if (error) throw error;
          if (typeof data !== "string") throw new Error("The new campaign ID was not returned.");
          setNotice("New campaign created. Run its planner to build the new route.");
          navigate(`/clients/${clientId}/delivery/campaign-factory/${data}${v2 ? "?view=v2" : ""}`);
        }}
        onSaved={() => { setCloneSource(null); void refresh(); }}
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
          payload={{ clientId, template: proposeTemplate }}
          requireNotes={false}
          maxNotesLength={null}
          extra={
            <div>
              <label
                htmlFor="propose-template"
                className="block text-sm font-medium text-card-foreground"
              >
                Campaign template (optional)
              </label>
              <select
                id="propose-template"
                value={proposeTemplate}
                onChange={(e) => setProposeTemplate(e.target.value)}
                className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {[NO_TEMPLATE, ...templateOptions()].map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {chosenTemplate && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {templateSummary(chosenTemplate)}
                </p>
              )}
            </div>
          }
          onClose={() => setProposing(false)}
          onGenerated={(draft) => {
            // A saved draft wins over initialValues inside FormModal, so a
            // half-typed form would silently swallow the proposal.
            clearDraft(`campaign:${clientId}`);
            // The template rides along so the form opens on the same choice
            // the proposal was written for. Losing it here would leave a
            // brief aimed at S1 sitting in a campaign with no template.
            setAiDraft({ ...draft, template: proposeTemplate });
          }}
        />
      )}
    </div>
  );
}
