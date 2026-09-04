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
import { runIdeationJob } from "../agents/ideation/index.js";
import { runBriefJob } from "../agents/brief/index.js";

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
) => Promise<JobResult>;

// Agents land one at a time, each with its own gate.
const RUNNERS: Record<string, JobRunner> = {
  icp: runIcpJob,
  competitor: runCompetitorJob,
  association: runAssociationJob,
  campaign_intel: runCampaignIntelJob,
  brand_strategy: runBrandStrategyJob,
  offer_strategy: runOfferStrategyJob,
  money_model: runMoneyModelJob,
  ideation: runIdeationJob,
  brief: runBriefJob,
  // `market` is registered in the agents table but deliberately absent
  // here: it has no record_templates rows and no tab in the client nav,
  // so it has nothing to produce and nowhere to show it. A job queued for
  // it fails loudly as NO_RUNTIME_IMPLEMENTATION, which is the honest
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
  return runner(sb, config, agent, job);
}
