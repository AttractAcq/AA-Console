import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { fetchCampaignOrigins, fetchOpportunities, fetchOpportunityApprovalStates,
  fetchOpportunityOfferVersions, fetchReadiness, type CampaignOrigin } from "../../lib/opportunities";
import { fetchLaunchDue, type LaunchDue } from "../../lib/campaignLaunch";
import { CampaignLaunchGate } from "./CampaignLaunchGate";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";
import {
  NO_TEMPLATE,
  templateFor,
  templateOptions,
  templateSummary,
} from "../../lib/campaignTemplates";
import { CampaignContentPanel } from "./CampaignContentPanel";
import { MetaBuildSection } from "./MetaBuildSection";
import { cn } from "../../lib/cn";
import { Modal } from "../../components/Modal";
import { PageBuilderPanel } from "../conversion/PageBuilderPanel";
import { SalesOverviewPanel } from "../sales/SalesOverviewPanel";
import { useCampaignV2Package } from "./useCampaignV2Package";
import { CampaignSweepWork } from "./CampaignSweepWork";
import { CampaignConversionWork } from "./CampaignConversionWork";
import { CampaignPackageReadiness } from "./CampaignPackageReadiness";

type ContentSpecPiece = { route: string; platform: string; media_type: string; content_format: string };
type PlannedIdea = { id: string; campaign_position: number | null; title: string; body: string | null };

type Campaign = {
  id: string;
  acquisition_mode: "legacy" | "organic" | "paid" | "both";
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
  content_spec_id: string | null;
  plan_approved_at: string | null;
  plan_approved_fingerprint: string | null;
  plan_review_note: string | null;
  needs_landing_page: boolean;
  needs_sales_agent: boolean;
  needs_lead_magnet: boolean;
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

function campaignRouteLabel(campaign: Campaign): string {
  if (campaign.acquisition_mode === "legacy") return "Legacy campaign";
  if (campaign.acquisition_mode === "organic") return "Organic";
  const paidChannel = campaign.paid_platform === "meta" ? "Meta Ads"
    : campaign.paid_platform === "google" ? "Google Ads" : "Paid platform unknown";
  return campaign.acquisition_mode === "both"
    ? `Organic + Paid · ${paidChannel}` : `Paid · ${paidChannel}`;
}

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
    options: [{ value: "organic", label: "Organic" }, { value: "paid", label: "Paid" },
      { value: "both", label: "Organic + paid" }],
    hint: "Choose either route or coordinate both. Each route has separate assets and approvals." },
  { name: "paid_platform", label: "Paid platform", kind: "select", required: true,
    showIf: { field: "acquisition_mode", equals: ["paid", "both"] },
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

const ACTION_KINDS = ["archive", "delete", "plan", "launch", "clone"] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

const ACTION_LABELS: Record<ActionKind, string> = {
  archive: "Archive", delete: "Delete", plan: "Run planner",
  launch: "Launch", clone: "Clone to another route",
};

/** Launching needs a ready legacy campaign: a new route goes live on approval. */
function canLaunch(campaign: Campaign, checks: Requirement[]): boolean {
  return campaign.status !== "live" && campaign.acquisition_mode === "legacy"
    && checks.length > 0 && checks.every((check) => check.met);
}

/**
 * The five things that can be done to a campaign.
 *
 * The same set on a list row as on the campaign's own page. Deciding to
 * launch, re-plan or clone while reading down the list is ordinary, and
 * making somebody open a campaign to find out it cannot be launched is not a
 * safeguard. What stops a wrong one is the gating and the confirmation, both
 * of which belong to the campaign rather than to the view it is shown in.
 */
function CampaignActions({ campaign, checks, busy, planning, onChoose }: {
  campaign: Campaign;
  checks: Requirement[];
  busy: boolean;
  planning: boolean;
  onChoose: (kind: ActionKind) => void;
}) {
  const launchAvailable = canLaunch(campaign, checks);
  return (
    <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-border bg-card p-3" role="group" aria-label="Campaign actions">
      {ACTION_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={buttonClass}
          disabled={busy || (kind === "launch" && !launchAvailable) || (kind === "plan" && planning)}
          onClick={() => onChoose(kind)}
        >
          {ACTION_LABELS[kind]}
        </button>
      ))}
      {!launchAvailable && campaign.status !== "live" && (
        <p className="w-full text-xs text-muted-foreground">
          Launch requires a ready legacy campaign. New routes require version-bound human approval.
        </p>
      )}
    </div>
  );
}

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
  return <CampaignExecutionPanelContent key={`${clientId ?? "no-client"}:${campaignId ?? "list"}`} />;
}

function CampaignExecutionPanelContent() {
  const { clientId, campaignId } = useParams<{ clientId: string; campaignId?: string }>();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [contentSpec, setContentSpec] = useState<ContentSpecPiece[] | null>(null);
  const [contentSpecError, setContentSpecError] = useState<string | null>(null);
  const [plannedIdeas, setPlannedIdeas] = useState<PlannedIdea[] | null>(null);
  const [readiness, setReadiness] = useState<Record<string, Requirement[]>>({});
  /** Why each campaign exists, where an opportunity says so. */
  const [origins, setOrigins] = useState<ReadonlyMap<string, CampaignOrigin>>(new Map());
  const [originsState, setOriginsState] = useState<"loading" | "ready" | "error">("loading");
  const [newOpen, setNewOpen] = useState(false);
  const [newOpportunityChoices, setNewOpportunityChoices] = useState<Array<{ id: string; label: string }>>([]);
  const [newOpportunityId, setNewOpportunityId] = useState("");
  const [newOpportunityError, setNewOpportunityError] = useState<string | null>(null);
  const [newOfferChoices, setNewOfferChoices] = useState<Array<{ id: string; label: string }>>([]);
  const [newOfferVersionId, setNewOfferVersionId] = useState("");
  const [newOfferError, setNewOfferError] = useState<string | null>(null);
  const [cloneSource, setCloneSource] = useState<Campaign | null>(null);
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
  const [launchDue, setLaunchDue] = useState<ReadonlyMap<string, LaunchDue>>(new Map());
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
  const packageState = useCampaignV2Package(clientId, campaignId, Boolean(campaignId));

  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoadError(null);
    setReadinessError(null);
    setLoading(true);
    setReadiness({});
    setOriginsState("loading");
    setContentSpec(null);
    setContentSpecError(null);
    setPlannedIdeas(null);
    try {
      if (!clientId) {
        throw new Error("No client selected.");
      }
      const query = supabase
        .from("client_campaigns")
        .select(
          "id, name, brief, status, objective, audience, offer_summary, core_message, channels, budget, starts_on, ends_on, kpi_metric, kpi_target, content_count, content_spec_id, plan_approved_at, plan_approved_fingerprint, plan_review_note, needs_landing_page, needs_sales_agent, needs_lead_magnet, built_at, content_ideas_generated_at, ideate_on_plan, launched_at, created_at, template, mirrors_template, daily_budget, target_countries, conversion_event, meta_campaign_id, meta_ad_set_id, meta_built_at, acquisition_mode, paid_platform, cloned_from_campaign_id, offer_version_id",
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
      if (campaignId && rows[0]?.content_spec_id) {
        const { data: spec, error: specError } = await supabase
          .from("campaign_content_spec_versions_v7")
          .select("pieces")
          .eq("id", rows[0].content_spec_id)
          .maybeSingle();
        if (version !== request.current) return;
        if (specError || !spec || !Array.isArray(spec.pieces)) {
          setContentSpecError(specError?.message ?? "The content requirements could not be read.");
        } else {
          setContentSpec(spec.pieces as ContentSpecPiece[]);
        }
        if (rows[0].content_ideas_generated_at) {
          const { data: ideaRows, error: ideaError } = await supabase.from("client_ideas")
            .select("id, campaign_position, title, body")
            .eq("campaign_id", rows[0].id).eq("client_id", clientId)
            .order("campaign_position", { ascending: true });
          if (version !== request.current) return;
          if (ideaError) setContentSpecError(ideaError.message);
          else setPlannedIdeas(ideaRows ?? []);
        }
      }

      // Lineage, not status: a campaign with no recorded commercial reason
      // is the normal case for everything made before the opportunity
      // engine existed, so a failure here leaves the page working and the
      // line absent rather than failing the load.
      void fetchCampaignOrigins(clientId)
        .then((found) => {
          if (version === request.current) {
            setOrigins(found);
            setOriginsState("ready");
          }
        })
        .catch(() => {
          if (version === request.current) {
            setOrigins(new Map());
            setOriginsState("error");
          }
        });
      // A failed lineage read must not suppress the independent launch verdict.
      void fetchLaunchDue(clientId)
        .then((found) => { if (version === request.current) setLaunchDue(found); })
        .catch(() => { if (version === request.current) setLaunchDue(new Map()); });

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
    if (!newOpen || !clientId) return;
    let cancelled = false;
    setNewOpportunityChoices([]);
    setNewOpportunityError(null);
    void Promise.all([
      fetchOpportunities(clientId), fetchOpportunityApprovalStates(clientId), fetchReadiness(clientId),
    ]).then(([opportunities, approvals, readinessById]) => {
      if (cancelled) return;
      setNewOpportunityChoices(opportunities
        .filter((opportunity) => ["approved", "active", "learning", "scaling"].includes(opportunity.status)
          && approvals.get(opportunity.id) === "current"
          && readinessById.get(opportunity.id)?.blocker === null)
        .map((opportunity) => ({ id: opportunity.id, label: opportunity.name })));
    }).catch((cause) => {
      if (!cancelled) setNewOpportunityError(cause instanceof Error ? cause.message : "Opportunities could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [newOpen, clientId]);

  useEffect(() => {
    if (!newOpen || !clientId || !newOpportunityId) return;
    let cancelled = false;
    setNewOfferChoices([]);
    setNewOfferVersionId("");
    setNewOfferError(null);
    void fetchOpportunityOfferVersions(clientId, newOpportunityId).then((choices) => {
      if (!cancelled) setNewOfferChoices(choices);
    }).catch((cause) => {
      if (!cancelled) setNewOfferError(cause instanceof Error ? cause.message : "Offer versions could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [newOpen, clientId, newOpportunityId]);

  useEffect(() => {
    if (!editingPlan || !clientId) return;
    let cancelled = false;
    const origin = origins.get(editingPlan.id);
    setApprovedOfferChoices([]);
    setOffersFailed(!origin);
    if (origin) void fetchOpportunityOfferVersions(clientId, origin.opportunity_id)
      .then((choices) => {
        if (!cancelled) {
          setApprovedOfferChoices(choices);
          setOffersFailed(false);
        }
      }).catch(() => { if (!cancelled) setOffersFailed(true); });
    return () => { cancelled = true; };
  }, [editingPlan, clientId, origins]);

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

  // Same reasoning for a sweep in flight. request_campaign_sweep_v6 refuses a
  // second one anyway; this is so the button says so before it is pressed.
  const sweeping = new Set(
    inFlight.filter((j) => j.agent_key === "campaign_sweep").map((j) => j.input_id),
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
   * Approve this plan for building (migration 309).
   *
   * The gate is in provision_campaign, which refuses an unreviewed plan and
   * refuses one that changed after approval. So this button does not unlock a
   * screen -- it records a decision about a specific plan, and correcting the
   * plan afterwards withdraws it.
   */
  const approvePlan = async (campaign: Campaign) => {
    const note = window.prompt("Anything to record about this plan? (optional)") ?? null;
    setBusy(true);
    setProblem(null);
    const { error } = await supabase.rpc("approve_campaign_plan_v6", {
      p_campaign_id: campaign.id,
      ...(note?.trim() ? { p_note: note.trim() } : {}),
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    setNotice(`Plan approved for "${campaign.name}". The agents can build from it now.`);
    void refresh();
  };

  /**
   * Sweep an approved plan into work (migration 310).
   *
   * This queues the composer rather than composing anything here.
   * create_workflow_run requires auth.role() = 'service_role', and a definer
   * function does not change auth.role() -- it reads the caller's JWT claim --
   * so a browser cannot write a workflow run however the function is declared.
   * The runtime composes it, and re-checks the approval first, because
   * correcting a plan withdraws it.
   */
  const sweep = async (campaign: Campaign) => {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase.rpc("request_campaign_sweep_v6", {
      p_campaign_id: campaign.id,
    });
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    setNotice(
      `Sweeping "${campaign.name}" into work. A step chain per planned piece; each still needs its own approval before anything goes out.`,
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
  const deleteCampaign = async (campaign: Campaign) => {
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
    if (campaignId) navigate(`/clients/${clientId}/delivery/campaign-factory`);
    else void refresh();
  };

  /** A planned campaign can have approved creative and an immutable v6 package.
   * Regeneration therefore makes a linked revision and preserves the source. */
  const createPlanRevision = async (campaign: Campaign, brief: string, changes?: { template: string; offerVersionId: string | null }) => {
    if (!clientId) throw new Error("No client selected.");
    if (changes && changes.offerVersionId !== campaign.offer_version_id && offersFailed)
      throw new Error("Signed secondary offers for this opportunity could not be loaded.");
    if (changes?.offerVersionId && changes.offerVersionId !== campaign.offer_version_id
      && !approvedOfferChoices.some((offer) => offer.id === changes.offerVersionId))
      throw new Error("Choose a current signed secondary offer from this campaign's approved opportunity.");
    const offerVersionId = changes ? changes.offerVersionId : campaign.offer_version_id;
    if (!offerVersionId) throw new Error("This campaign has no signed secondary offer. Link an approved opportunity and offer before revising it.");
    const nextTemplate = changes?.template ?? campaign.template;
    if (nextTemplate && !templateFor(nextTemplate)) throw new Error("Choose a valid campaign template.");
    const { data, error } = await supabase.rpc("create_sourced_campaign_revision_v7", {
      p_campaign_id: campaign.id,
      p_brief: brief,
      p_offer_version_id: offerVersionId,
      p_template: nextTemplate || undefined,
    });
    if (error) throw error;
    navigate(`/clients/${clientId}/delivery/campaign-factory/${data.id}`);
  };

  const runConfirmedAction = async () => {
    if (!confirmAction || !clientId) return;
    const { campaign, kind } = confirmAction;
    setConfirmAction(null);
    setActionsOpen(false);
    setRowActions(null);
    if (kind === "clone") { setCloneSource(campaign); return; }
    if (kind === "delete") { await deleteCampaign(campaign); return; }
    if (kind === "plan") {
      if (campaign.built_at) {
        try { await createPlanRevision(campaign, campaign.brief); }
        catch (error) { setProblem((error as Error).message); }
      } else await plan(campaign);
      return;
    }
    if (kind === "launch") { await act("launch_campaign", campaign, () => `"${campaign.name}" is live.`); return; }
    setBusy(true);
    const { error } = await supabase.rpc("set_client_archive_v8", {
      p_client_id: clientId, p_table_name: "client_campaigns",
      p_record_id: campaign.id, p_archive: true,
    });
    setBusy(false);
    if (error) setProblem(error.message);
    else if (campaignId) navigate(`/clients/${clientId}/delivery/campaign-factory`);
    else { setNotice(`Archived "${campaign.name}".`); void refresh(); }
  };

  const visibleCampaigns = campaignId ? campaigns.filter((campaign) => campaign.id === campaignId) : campaigns;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      {campaignId && clientId && <Link to={`/clients/${clientId}/delivery/campaign-factory`} className="mb-4 inline-block text-sm text-brand-strong hover:underline">← All campaigns</Link>}
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
      ) : (
        campaignId ? visibleCampaigns.map((c) => {
          const reqs = readiness[c.id] ?? [];
          const paid = c.acquisition_mode === "paid" || c.acquisition_mode === "both";
          const tabs = paid ? [ ["plan", "Plan"], ["content", "Content"], ["landing-page", "Landing Page"], ["sales-agent", "Sales Agent"], ...(c.paid_platform === "meta" ? [["meta-ads", "Meta Ads"]] as const : []), ["launch", "Launch state"] ] as const : [ ["plan", "Plan"], ["content", "Content"], ["launch", "Launch state"] ] as const;
          return <div key={c.id}>
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-3"><h2 className="text-lg font-semibold">{c.name}</h2><span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_TONE[c.status] ?? "bg-muted text-muted-foreground")}>{c.status}</span></div>
                  <p className="mt-1 text-xs text-muted-foreground">{campaignRouteLabel(c)}
                    {c.cloned_from_campaign_id && <>{" · "}<Link className="text-brand-strong underline" to={`/clients/${clientId}/delivery/campaign-factory/${c.cloned_from_campaign_id}`}>Source campaign</Link></>}
                  </p></div>
                <button type="button" className={buttonClass} onClick={() => setEditing(c)}>Edit campaign</button>
              </div>
              {/* Why this campaign exists, where something says so. Read from
                  the opportunity as it stands now rather than copied at
                  creation: a campaign built on something since paused should
                  say that, not carry a snapshot of how it looked in October. */}
              {origins.get(c.id) && (() => {
                const origin = origins.get(c.id)!;
                return (
                  <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                    <p>
                      <span className="text-muted-foreground">Built for the opportunity </span>
                      <Link
                        className="font-medium text-brand-strong underline"
                        to={`/clients/${clientId}/delivery/market-opportunities?view=evaluate&opportunity=${origin.opportunity_id}`}
                      >
                        {origin.opportunity_name}
                      </Link>
                      <span className="text-muted-foreground">
                        {" "}· {origin.opportunity_status}
                        {origin.score != null && ` · scored ${origin.score}`}
                        {origin.classification && ` (${origin.classification})`}
                        {" "}· {origin.confidence.replaceAll("_", " ")}
                      </span>
                    </p>
                    <p className="mt-1 text-muted-foreground">{origin.micro_market}</p>
                    {origin.opportunity_blocker && (
                      <p className="mt-1 text-destructive">
                        The opportunity behind this is no longer ready: {origin.opportunity_blocker}
                      </p>
                    )}
                  </div>
                );
              })()}
              {originsState === "ready" && !origins.has(c.id) && (
                <p className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  No opportunity source is recorded for this campaign. It remains readable, but a new plan revision or route clone needs an approved opportunity and signed secondary offer.
                </p>
              )}
              {originsState === "error" && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  Campaign opportunity sources could not be read. Source-dependent actions remain unverified.
                </p>
              )}
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
            {clientId && c.acquisition_mode !== "legacy" &&
              <CampaignPackageReadiness campaignId={c.id} clientId={clientId} />}
            {clientId && c.acquisition_mode !== "legacy" &&
              <CampaignSweepWork clientId={clientId} campaignId={c.id} />}
            {clientId && c.acquisition_mode !== "legacy"
              && (c.needs_landing_page || c.needs_sales_agent || c.needs_lead_magnet) &&
              <CampaignConversionWork clientId={clientId} campaignId={c.id}
                needsPage={c.needs_landing_page} needsAgent={c.needs_sales_agent}
                needsMagnet={c.needs_lead_magnet} />}
            <div className="relative mt-4">
              <Button onClick={() => setActionsOpen((open) => !open)}>Action buttons</Button>
              {actionsOpen && <CampaignActions campaign={c} checks={reqs} busy={busy} planning={planning.has(c.id)} onChoose={(kind) => setConfirmAction({ campaign: c, kind })} />}
            </div>
            <div className="mt-6 flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Campaign sections">
              {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={v2Tab === id} onClick={() => setV2TabSelection({ campaignId, tab: id })} className={cn("border-b-2 px-4 py-2 text-sm", v2Tab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>)}
            </div>
            {v2Tab === "plan" && <section className="space-y-4 py-4" aria-label="Campaign plan">
              <div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold">Campaign plan</h3><p className="text-xs text-muted-foreground">{c.built_at ? `Generated ${new Date(c.built_at).toLocaleString()}` : "Awaiting planner"}</p></div><div className="flex gap-2"><button type="button" className={buttonClass} onClick={() => setEditingPlan(c)}>Edit plan</button><button type="button" className={buttonClass} disabled={busy || planning.has(c.id)} onClick={() => setConfirmAction({ campaign: c, kind: "plan" })}>{c.built_at ? "Regenerate plan" : "Run planner"}</button></div></div>
              <dl className="grid gap-4 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Objective</dt><dd>{c.objective ?? "—"}</dd></div><div><dt className="text-muted-foreground">Audience</dt><dd>{c.audience ?? "—"}</dd></div><div><dt className="text-muted-foreground">Offer</dt><dd>{c.offer_summary ?? "—"}</dd></div><div><dt className="text-muted-foreground">Core message</dt><dd>{c.core_message ?? "—"}</dd></div><div><dt className="text-muted-foreground">Channels</dt><dd>{c.channels?.join(", ") || "—"}</dd></div><div><dt className="text-muted-foreground">Budget</dt><dd>{c.budget == null ? "—" : c.budget.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">Dates</dt><dd>{c.starts_on ?? "—"} to {c.ends_on ?? "—"}</dd></div><div><dt className="text-muted-foreground">KPI</dt><dd>{c.kpi_metric ?? "—"}{c.kpi_target != null ? ` · target ${c.kpi_target}` : ""}</dd></div><div><dt className="text-muted-foreground">Content pieces</dt><dd>{c.content_count}</dd></div><div><dt className="text-muted-foreground">Required builds</dt><dd>{[c.needs_landing_page && "Landing page", c.needs_sales_agent && "Sales agent", c.needs_lead_magnet && "Lead magnet"].filter(Boolean).join(", ") || "None"}</dd></div></dl>
              {c.built_at && c.acquisition_mode !== "legacy" && <div className="flex flex-wrap items-center gap-3 text-xs">
                <span>Lead magnet required: {c.needs_lead_magnet ? "Yes" : "No"}</span>
                <button type="button" className={buttonClass}
                  disabled={busy || c.plan_approved_at !== null}
                  onClick={async () => {
                    setBusy(true); setProblem(null);
                    const { error } = await supabase.rpc("set_campaign_magnet_requirement_v7", {
                      p_campaign_id: c.id, p_required: !c.needs_lead_magnet,
                    });
                    setBusy(false);
                    if (error) setProblem(error.message);
                    else { setNotice("Magnet requirement changed. Review and approve the plan."); void refresh(); }
                  }}>
                  {c.needs_lead_magnet ? "Remove magnet requirement" : "Require a lead magnet"}
                </button>
                {c.plan_approved_at !== null && <span className="text-muted-foreground">Regenerate the plan to change this requirement.</span>}
              </div>}
              {c.acquisition_mode !== "legacy" && c.content_count > 0 && (
                <div className="rounded-lg border border-border bg-card p-4 text-sm">
                  <h4 className="font-medium">Content requirements to review</h4>
                  {contentSpecError && <p role="alert" className="mt-2 text-destructive">{contentSpecError}</p>}
                  {!contentSpec && !contentSpecError && <p className="mt-2 text-muted-foreground">No route and format requirements recorded. Run the planner before approval.</p>}
                  {contentSpec && <ol className="mt-2 space-y-3">{contentSpec.map((piece, index) => <li key={index}>
                    <p>{index + 1}. {piece.route} · {piece.platform} · {piece.media_type} · {piece.content_format}</p>
                    {plannedIdeas?.[index] && <div className="mt-1 pl-4"><p className="font-medium">{plannedIdeas[index].title}</p><p className="whitespace-pre-wrap text-muted-foreground">{plannedIdeas[index].body}</p></div>}
                  </li>)}</ol>}
                  {c.content_ideas_generated_at && plannedIdeas?.length !== c.content_count && <p role="alert" className="mt-2 text-destructive">The saved idea batch is incomplete; plan approval is held.</p>}
                </div>
              )}
              {/* The plan review gate (migration 309). Not a lock on this
                  screen: provision_campaign refuses an unreviewed plan and
                  refuses one that changed after approval, so correcting a plan
                  withdraws its approval and the state below says so. */}
              {c.built_at && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
                  <div>
                    <p className="text-sm font-medium">
                      {c.plan_approved_at === null
                        ? "This plan has not been reviewed"
                        : "Plan approved"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.plan_approved_at === null
                        ? "The planner wrote it. Nothing is built from a plan until a person has read it."
                        : `Approved ${new Date(c.plan_approved_at).toLocaleString()}${c.plan_review_note ? ` · ${c.plan_review_note}` : ""}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || (c.acquisition_mode !== "legacy" && c.content_count > 0 &&
                      (contentSpec?.length !== c.content_count || (c.content_ideas_generated_at !== null && plannedIdeas?.length !== c.content_count)))}
                    onClick={() => void approvePlan(c)}
                  >
                    {c.plan_approved_at === null ? "Approve this plan" : "Approve again"}
                  </button>
                </div>
              )}
              {/* The sweep prepares the reviewed content mix and any required
                  page and sales-agent drafts. All remain inside the workflow
                  until internal QA and human review. */}
              {c.built_at && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
                  <div>
                    <p className="text-sm font-medium">Sweep into work</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.plan_approved_at === null
                        ? "Approve the plan first. A sweep is the moment a plan becomes work, so it refuses an unreviewed one."
                        : sweeping.has(c.id)
                          ? "A sweep of this campaign is queued. One at a time, so two sweeps cannot compose the same steps twice."
                          : `Prepares ${c.content_count} ${c.content_count === 1 ? "piece" : "pieces"} of planned content${c.needs_landing_page ? ", a page" : ""}${c.needs_sales_agent ? ", a sales agent" : ""}${c.needs_lead_magnet ? ", and a lead magnet PDF" : ""}. Each output stops for review before public use.`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || c.plan_approved_at === null || sweeping.has(c.id)}
                    onClick={() => void sweep(c)}
                  >
                    {sweeping.has(c.id) ? "Sweeping…" : "Sweep into work"}
                  </button>
                </div>
              )}
            </section>}
            {v2Tab === "launch" && (launchDue.get(c.id)
              ? <section className="py-4" aria-label="Launch"><CampaignLaunchGate due={launchDue.get(c.id)!} /></section>
              : <section className="py-4"><p className="text-sm text-muted-foreground">No launch verdict yet. A campaign needs a package before there is anything to launch.</p></section>)}
            {v2Tab === "content" && clientId && <CampaignContentPanel key={`${clientId}:${c.id}:v2`} clientId={clientId} campaignId={c.id} contentCount={c.content_count} builtAt={c.built_at} contentIdeasGeneratedAt={c.content_ideas_generated_at} template={c.template} mirrorsTemplate={c.mirrors_template} onChanged={refresh} refreshToken={campaigns} layout="v2" />}
            {paid && v2Tab === "landing-page" && clientId && <PageBuilderPanel key={c.id} clientId={clientId} campaignId={c.id} campaignName={c.name} />}
            {paid && v2Tab === "sales-agent" && <SalesOverviewPanel key={c.id} campaignId={c.id} campaignName={c.name} />}
            {paid && c.paid_platform === "meta" && v2Tab === "meta-ads" && clientId && <section className="py-4"><div className="rounded-lg border border-border bg-card p-4 text-sm"><h3 className="font-semibold">Meta activation</h3><p className="mt-2 text-xs text-muted-foreground">{packageState.manifest ? `Current package v${packageState.manifest.version}. ` : "A planned package is required. "}{packageState.approvals.filter((approval) => approval.action_key === "meta_ad_build").map((approval) => `Meta ad build approval: ${approval.status}. `).join("") || "No Meta build approval is recorded for this package. "}Prepare the build sheet and approved creative here. Creating Meta objects still awaits the exact-version approval executor.</p><Link className="mt-2 inline-block text-xs text-brand-strong underline" to={`/clients/${clientId}/delivery/approval-inbox?tab=campaign-actions`}>Open Approval Inbox</Link>{c.meta_campaign_id && <p className="mt-2 text-xs">Meta campaign {c.meta_campaign_id}{c.meta_ad_set_id ? ` · ad set ${c.meta_ad_set_id}` : " · ad set pending"}{c.meta_built_at ? ` · recorded ${new Date(c.meta_built_at).toLocaleString()}` : ""}</p>}</div><div className="mt-3 flex justify-end"><Button onClick={() => setMetaToolsOpenFor((open) => open === c.id ? null : c.id)}>Build functionality</Button></div>{metaToolsOpen && <MetaBuildSection clientId={clientId} campaign={c} building={inFlight.some((job) => job.agent_key === "meta_build" && job.input_id === c.id)} onChanged={() => { void refresh(); void packageState.refresh(); }} externalActionsAvailable={false} handBuildAvailable showSheetInline />}</section>}
          </div>;
        }) : <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm"><thead className="border-b border-border bg-muted/40"><tr><th className="p-3">Campaign</th><th className="p-3">Route</th><th className="p-3">Source</th><th className="p-3">Type</th><th className="p-3">Date</th><th className="p-3">Status</th><th className="p-3">Production stage</th><th className="p-3">Actions</th></tr></thead><tbody>{visibleCampaigns.map((c) => <tr key={c.id} className="border-b border-border last:border-0"><td className="p-3"><Link className="font-medium text-brand-strong hover:underline" to={`/clients/${clientId}/delivery/campaign-factory/${c.id}`}>{c.name}</Link>{c.cloned_from_campaign_id && <span className="block text-xs text-muted-foreground">Revised or cloned from another campaign</span>}</td><td className="p-3">{campaignRouteLabel(c)}</td><td className="p-3">{originsState === "loading" ? "Checking…" : originsState === "error" ? "Unavailable" : origins.has(c.id) ? "Opportunity linked" : "No link recorded"}</td><td className="p-3">{c.acquisition_mode === "both" ? "Both" : c.acquisition_mode === "legacy" ? "Not specified" : c.acquisition_mode === "organic" ? "Organic" : "Paid"}</td><td className="p-3">{new Date(c.created_at).toLocaleDateString()}</td><td className="p-3 capitalize">{c.status}</td><td className="p-3">{productionStage(c, readiness[c.id] ?? [], planning.has(c.id))}</td><td className="p-3"><button type="button" className={buttonClass} aria-expanded={rowActions === c.id} onClick={() => setRowActions(rowActions === c.id ? null : c.id)}>Actions</button>{rowActions === c.id && <CampaignActions campaign={c} checks={readiness[c.id] ?? []} busy={busy} planning={planning.has(c.id)} onChoose={(kind) => setConfirmAction({ campaign: c, kind })} />}</td></tr>)}</tbody></table></div>
      )}

      <FormModal
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          setAiDraft(null);
          setNewOpportunityId("");
          setNewOfferVersionId("");
          setChosenPillars([]);
        }}
        title="New Campaign"
        draftKey={`campaign:${clientId}`}
        intro="Choose an approved market opportunity and its signed secondary offer. The campaign keeps that exact source, your planning direction and any selected template or pillars. The planner is queued after all inputs are saved."
        fields={FIELDS}
        extra={
          <div className="space-y-3">
            <label className="block text-sm font-medium text-foreground">
              Approved market opportunity
              <select className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
                value={newOpportunityId} onChange={(event) => {
                  setNewOpportunityId(event.target.value);
                  setNewOfferVersionId("");
                  setNewOfferChoices([]);
                }}>
                <option value="">Select…</option>
                {newOpportunityChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </select>
            </label>
            {newOpportunityError && <p role="alert" className="text-sm text-destructive">Opportunities unavailable: {newOpportunityError}</p>}
            {!newOpportunityError && newOpportunityChoices.length === 0 &&
              <p className="text-xs text-muted-foreground">No approved, ready opportunities are available for this client.</p>}
            <label className="block text-sm font-medium text-foreground">
              Signed secondary offer version
              <select className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2"
                value={newOfferVersionId} disabled={!newOpportunityId}
                onChange={(event) => setNewOfferVersionId(event.target.value)}>
                <option value="">Select…</option>
                {newOfferChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </select>
            </label>
            {newOfferError && <p role="alert" className="text-sm text-destructive">Offer versions unavailable: {newOfferError}</p>}
            {newOpportunityId && !newOfferError && newOfferChoices.length === 0 &&
              <p className="text-xs text-muted-foreground">No signed secondary offer version is linked to this opportunity yet.</p>}
            {pillarsFailed ? (
            <p role="alert" className="rounded-md border border-border p-3 text-sm text-destructive">
              Could not load this client&apos;s content pillars, so none can be picked. The campaign can
              still be planned without pillars.
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
          ) : null}
          </div>
        }
        submitLabel="Plan it"
        initialValues={newCampaignValues}
        resetKey={aiDraft}
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
          if (newOpportunityError) throw new Error("Approved opportunities could not be loaded.");
          if (!newOpportunityChoices.some((choice) => choice.id === newOpportunityId))
            throw new Error("Choose a currently approved and ready market opportunity.");
          if (newOfferError) throw new Error("Signed secondary offers could not be loaded.");
          if (!newOfferChoices.some((choice) => choice.id === newOfferVersionId))
            throw new Error("Choose a signed secondary offer version linked to that opportunity.");
          if (pillarsFailed && chosenPillars.length > 0)
            throw new Error("Content pillars could not be checked.");
          const acquisitionMode = v.acquisition_mode;
          const paid = acquisitionMode === "paid" || acquisitionMode === "both";
          const paidPlatform = paid ? v.paid_platform : null;
          if (acquisitionMode !== "organic" && acquisitionMode !== "paid" && acquisitionMode !== "both")
            throw new Error("Choose an organic, paid, or combined route.");
          if (paid && paidPlatform !== "meta" && paidPlatform !== "google")
            throw new Error("Choose Meta Ads or Google Ads for this paid campaign.");
          const chosenTemplate = paidPlatform === "meta" ? (v.template as string) : "";
          if (chosenTemplate && !templateFor(chosenTemplate))
            throw new Error("Choose a known campaign template.");
          const { error } = await supabase.rpc("create_sourced_campaign_plan_v7", {
            p_client_id: clientId,
            p_opportunity_id: newOpportunityId,
            p_offer_version_id: newOfferVersionId,
            p_name: (v.name as string).trim(),
            p_direction: (v.brief as string).trim(),
            p_acquisition_mode: acquisitionMode,
            p_ideate_on_plan: v.ideate_on_plan !== false,
            ...(paid ? { p_paid_platform: paidPlatform as string } : {}),
            ...(chosenTemplate ? { p_template: chosenTemplate } : {}),
            p_pillar_ids: chosenPillars,
          });
          if (error) throw new Error(error.message);
          setNotice("Queued. The planner is writing the campaign now.");
        }}
        onSaved={() => {
          setAiDraft(null);
          setChosenPillars([]);
          setNewOpportunityId("");
          setNewOfferVersionId("");
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
          { name: "offer_version_id", label: "Signed secondary offer for this opportunity", kind: "select", options: approvedOfferChoices.map((offer) => ({ value: offer.id, label: offer.label })) },
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
            // Organic has no platform, and the function's default is null.
            ...(platform ? { p_paid_platform: platform } : {}),
            p_name: (v.name as string).trim(),
          });
          if (error) throw error;
          if (typeof data !== "string") throw new Error("The new campaign ID was not returned.");
          setNotice("New campaign created. Run its planner to build the new route.");
          navigate(`/clients/${clientId}/delivery/campaign-factory/${data}`);
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
