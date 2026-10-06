// agent_key -> the code that runs it.
//
// This map, not the agents table, decides what can execute. An agent
// registered in the database but missing here fails loudly as
// NO_RUNTIME_IMPLEMENTATION rather than being claimed and left to sit in
// `running` forever. In the v5 runtime that distinction is why no job ever
// wedged.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "./registry.js";
import type { AgentJobRow } from "../queue.js";
import { runCompetitorJob } from "../agents/competitor/index.js";
import { runIcpJob } from "../agents/icp/index.js";
import { runAssociationJob } from "../agents/association/index.js";
import { runCampaignIntelJob } from "../agents/campaign_intel/index.js";
import { runBrandStrategyJob } from "../agents/brand_strategy/index.js";
import { runOfferStrategyJob } from "../agents/offer_strategy/index.js";
import { runMoneyModelJob } from "../agents/money_model/index.js";
import { runMarketJob } from "../agents/market/index.js";
import { runProofJob } from "../agents/proof/index.js";
import { runIdeationJob } from "../agents/ideation/index.js";
import { runBriefJob } from "../agents/brief/index.js";
import { runLandingPageJob } from "../agents/landing_page/index.js";
import { runMetricsIngestJob } from "../agents/metrics_ingest/index.js";
import { runReportingJob } from "../agents/reporting/index.js";
import { runCreativeBuildJob } from "../agents/creative_build/index.js";
import { runVideoBuildJob } from "../agents/video_build/index.js";
import { runVideoEditJob } from "../agents/video_edit/index.js";
import { runIdeaSelectJob } from "../agents/idea_select/index.js";
import { runCopywriterJob } from "../agents/copywriter/index.js";
import { runTokenHealthJob } from "../agents/token_health/index.js";
import { runBriefDispatchJob } from "../agents/brief_dispatch/index.js";
import { deadlineFromNow } from "./deadline.js";
import { runRepurposeJob } from "../agents/repurpose/index.js";
import { runProofDiscoveryJob } from "../agents/proof_discovery/index.js";
import { runSalesAgentJob } from "../agents/sales_agent/index.js";
import { runCampaignPlanJob } from "../agents/campaign_plan/index.js";
import { runPageAuditJob } from "../agents/page_audit/index.js";
import { runPageReviseJob } from "../agents/page_revise/index.js";
import { runMetaBuildJob } from "../agents/meta_build/index.js";
import { runRecruitmentMetaBuildJob } from "../agents/recruitment_meta_build/index.js";
import { runMetaBuildSheetJob } from "../agents/meta_build_sheet/index.js";
import { checkClientBudget } from "./budget.js";

export interface JobResult {
  ok: boolean;
  retryable: boolean;
  failureMessage?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export type JobRunner = (
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
  /**
   * Epoch ms this attempt must be finished by. Runners that call a model take
   * it; the rest may ignore it, which TypeScript allows — a function of four
   * parameters satisfies a type of five.
   */
  deadlineAt: number,
) => Promise<JobResult>;

// Agents land one at a time, each with its own gate.
const RUNNERS: Record<string, JobRunner> = {
  icp: runIcpJob,
  market: runMarketJob,
  proof: runProofJob,
  competitor: runCompetitorJob,
  association: runAssociationJob,
  campaign_intel: runCampaignIntelJob,
  brand_strategy: runBrandStrategyJob,
  offer_strategy: runOfferStrategyJob,
  money_model: runMoneyModelJob,
  ideation: runIdeationJob,
  brief: runBriefJob,
  repurpose: runRepurposeJob,
  proof_discovery: runProofDiscoveryJob,
  landing_page: runLandingPageJob,
  // The page, and then the thing standing on it.
  sales_agent: runSalesAgentJob,
  // The orchestrator's planning half; the executing half is SQL.
  campaign_plan: runCampaignPlanJob,
  // The polish loop: one reports, a person chooses, the other acts.
  page_audit: runPageAuditJob,
  page_revise: runPageReviseJob,
  // Deterministic ETL, no model. Scheduled rather than run by hand.
  metrics_ingest: runMetricsIngestJob,
  // Reads what the ingest wrote and says what it means.
  reporting: runReportingJob,
  // A brief becomes an asset, or a brief reaches a person.
  creative_build: runCreativeBuildJob,
  // Generated reels. Opening stills are an image build on creative_build.
  // Motion calls Higgsfield only when the four HIGGSFIELD_* env vars are set.
  video_build: runVideoBuildJob,
  // The cut. video_build's assembly.ts hands a reel to a person; this is
  // the other half. A model writes the edit decision list, code validates
  // it against the clips and the brief's own claims, ffmpeg renders it.
  video_edit: runVideoEditJob,
  idea_select: runIdeaSelectJob,
  copywriter: runCopywriterJob,
  token_health: runTokenHealthJob,
  brief_dispatch: runBriefDispatchJob,
  // Approved assets become a paused Meta campaign. No model; launching stays
  // a person in Ads Manager.
  meta_build: runMetaBuildJob,
  recruitment_meta_build: runRecruitmentMetaBuildJob,
  // The same build written out for a person, for when there is no usable
  // token. Reads only, and never calls Meta.
  meta_build_sheet: runMetaBuildSheetJob,
  // outcome until that product decision is made.
};

export function hasRunner(agentKey: string): boolean {
  return agentKey in RUNNERS;
}

export function registeredAgentKeys(): string[] {
  return Object.keys(RUNNERS);
}

export async function dispatchJob(
  sb: SupabaseClient,
  config: RuntimeConfig,
  agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  const runner = RUNNERS[job.agent_key];
  if (!runner) {
    throw new Error(`No runtime implementation for agent_key "${job.agent_key}" (job ${job.id}).`);
  }
  // Before the runner, not inside it: a client over its monthly cap stops
  // here whatever the agent is, including one added later that forgets to
  // ask. Non-retryable, because a retry spends the money the cap refused and
  // three attempts at the same refusal is three lies about having tried.
  const budget = await checkClientBudget(sb, job.client_id);
  if (!budget.allowed) {
    return { ok: false, retryable: false, failureMessage: budget.message };
  }
  // Computed here rather than inside each runner so every agent is bounded by
  // construction, including any added later that forgets to ask.
  return runner(sb, config, agent, job, deadlineFromNow(config));
}
