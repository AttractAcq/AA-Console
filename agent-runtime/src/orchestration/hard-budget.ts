import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJobRow } from "../queue.js";

export class HardBudgetHold extends Error {
  constructor(message: string, readonly requiredUsd: number | null = null) { super(message); }
}
export const hardBudget = new AsyncLocalStorage<AgentBudget>();
export const OUTPUT_TOKEN_LIMIT = 32_000;

// These runners use the same Messages loop exclusively. An unpriced runner or
// model is held before dispatch. Review its provider paths before adding it.
const searchLimits = new Map<string, number>([
  ["market", 15], ["icp", 0], ["offer_strategy", 0], ["opportunity_discovery", 0],
  ["opportunity_evaluate", 0], ["opportunity_strategise", 0], ["offer_compile", 0], ["campaign_plan", 0],
]);

const researchModel = "claude-sonnet-4-6";
async function clientPolicy(db: SupabaseClient, clientId: string) {
  try {
    const { data, error } = await db.rpc("client_model_budget_policy", { p_client_id: clientId });
    if (!error && (data === "legacy" || data === "reserved" || data === researchModel)) return data as string;
  } catch { /* A policy read failure cannot authorize spend. */ }
  throw new HardBudgetHold("Client model budget policy could not be verified.");
}

export async function requireDirectModelAccess(db: SupabaseClient, clientId: string) {
  if (await clientPolicy(db, clientId) !== "legacy") {
    throw new HardBudgetHold("This client requires a reserved agent job before a model call.");
  }
}

function rates(model: string) {
  if (model === "claude-opus-5") return { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 };
  if (model === researchModel) return { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 };
  throw new HardBudgetHold("Provider model has no reviewed hard-budget bound.");
}

// Reserve the full context for every server sampling iteration.
function turnBound(model: string, searches: number): number {
  if (!Number.isInteger(searches) || searches < 0 || searches > 15) {
    throw new HardBudgetHold("Provider request has no reviewed hard-budget bound.");
  }
  const price = rates(model);
  const iterations = searches ? 10 : 1;
  const inputMicros = 1_048_576 * (searches ? price.write1h : price.write5m);
  return (iterations * (inputMicros + OUTPUT_TOKEN_LIMIT * price.output) + searches * 10_000) / 1e6;
}

export class AgentBudget {
  private turn = 0;
  constructor(private db: SupabaseClient, private job: AgentJobRow, private owner: string) {}

  owns(job: AgentJobRow) {
    return job.id === this.job.id && job.attempts === this.job.attempts && job.client_id === this.job.client_id;
  }

  private async receipt(action: "reserve" | "settle", turn: number, usd: number) {
    try {
      const { error } = await this.db.rpc(action + "_agent_budget_turn", {
        p_job_id: this.job.id, p_attempt: this.job.attempts, p_owner: this.owner, p_turn: turn, p_usd: usd,
      });
      if (!error) return;
      if (/^Hard cap: call requires USD [\d.]+, available USD [\d.]+$/.test(error.message)) {
        throw new HardBudgetHold(error.message, usd);
      }
    } catch (error) {
      if (error instanceof HardBudgetHold) throw error;
    }
    throw new HardBudgetHold("Budget " + action + " could not be verified. Check the current cap, lease and reservation receipts.");
  }

  async prepare(model: string) {
    const searches = searchLimits.get(this.job.agent_key);
    if (searches === undefined) throw new HardBudgetHold("This agent has no reviewed model-spend bound.");
    if (!this.job.client_id) throw new HardBudgetHold("This job has no budget client.");
    if (this.job.agent_key === "market") {
      const policy = await clientPolicy(this.db, this.job.client_id);
      if (policy === "legacy") throw new HardBudgetHold("Claim and client budget policy disagree.");
      if (policy === researchModel) model = policy;
    }
    await this.receipt("reserve", 0, turnBound(model, searches));
    return model;
  }

  async beforeCall(model: string, searches: number) {
    if (searchLimits.get(this.job.agent_key) !== searches) throw new HardBudgetHold("Agent tools differ from the reviewed budget bound.");
    const turn = ++this.turn;
    await this.receipt("reserve", turn, turnBound(model, searches));
    return turn;
  }

  async settle(turn: number, usd: number) {
    await this.receipt("settle", turn, usd);
  }

  async finish() {
    // Turn zero is never a provider dispatch. Once turn one starts, SQL has
    // already transferred its hold. An ambiguous sent turn stays fully booked.
    await this.settle(0, 0);
  }
}

export function strictUsageUsd(model: string, usage: {
  input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  cache_read_input_tokens: number | null; server_tool_use: { web_search_requests: number } | null;
}, searchEnabled: boolean): number {
  const counter = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const optionalCounter = (n: unknown) => n === null || counter(n);
  if (!counter(usage.input_tokens) || !counter(usage.output_tokens) ||
      !optionalCounter(usage.cache_creation_input_tokens) || !optionalCounter(usage.cache_read_input_tokens) ||
      (usage.server_tool_use ? !counter(usage.server_tool_use.web_search_requests) : searchEnabled)) {
    throw new HardBudgetHold("Incomplete provider usage. Full reservation retained.");
  }
  const writes = usage.cache_creation_input_tokens ?? 0;
  const shortWrites = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const longWrites = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (!counter(shortWrites) || !counter(longWrites) || shortWrites + longWrites !== writes) {
    throw new HardBudgetHold("Incomplete cache write usage. Full reservation retained.");
  }
  const price = rates(model);
  return Math.ceil(usage.input_tokens * price.input + usage.output_tokens * price.output +
    shortWrites * price.write5m + longWrites * price.write1h + (usage.cache_read_input_tokens ?? 0) * price.read +
    (usage.server_tool_use?.web_search_requests ?? 0) * 10_000) / 1e6;
}
