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

// Standard global Claude API, Opus 5. Full context per server sampling
// iteration, not an estimate based on prompt length. Search may add context
// and cache writes. Rates and iteration assumptions are recorded in the runbook.
function turnBound(model: string, searches: number): number {
  if (model !== "claude-opus-5" || !Number.isInteger(searches) || searches < 0 || searches > 15) {
    throw new HardBudgetHold("Provider request has no reviewed hard-budget bound.");
  }
  const iterations = searches ? 10 : 1;
  const inputMicros = 1_048_576 * (searches ? 10 : 6.25);
  return (iterations * (inputMicros + OUTPUT_TOKEN_LIMIT * 25) + searches * 10_000) / 1e6;
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
    await this.receipt("reserve", 0, turnBound(model, searches));
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

export function strictUsageUsd(usage: {
  input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null; server_tool_use: { web_search_requests: number } | null;
}, searchEnabled: boolean): number {
  const counter = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const optionalCounter = (n: unknown) => n === null || counter(n);
  if (!counter(usage.input_tokens) || !counter(usage.output_tokens) ||
      !optionalCounter(usage.cache_creation_input_tokens) || !optionalCounter(usage.cache_read_input_tokens) ||
      (usage.server_tool_use ? !counter(usage.server_tool_use.web_search_requests) : searchEnabled)) {
    throw new HardBudgetHold("Incomplete provider usage. Full reservation retained.");
  }
  // Use the higher cache-write rate even if the receipt omits its TTL split.
  return Math.ceil(usage.input_tokens * 5 + usage.output_tokens * 25 +
    (usage.cache_creation_input_tokens ?? 0) * 10 + (usage.cache_read_input_tokens ?? 0) * 0.5 +
    (usage.server_tool_use?.web_search_requests ?? 0) * 10_000) / 1e6;
}
