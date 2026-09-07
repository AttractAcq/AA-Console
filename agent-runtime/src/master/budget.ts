// The Master AI spend ceiling.
//
// Two limits, because they catch different failures. The daily one bounds
// the bill. The per-conversation one catches a single thread that has gone
// in circles — which is the shape a runaway actually takes, and which a
// daily limit alone would only notice after it had eaten the day.
//
// Both are read from master_ai_spend(), the same function the console reads,
// so what an operator sees and what the runtime enforces cannot drift.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

export interface Spend {
  dayUsd: number;
  conversationUsd: number;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Dollars this turn may still spend before a limit is reached. */
  remainingUsd: number;
  /** Set when ok is false: what to tell the operator. */
  reason?: string;
}

const money = (v: number) => `$${v.toFixed(2)}`;

export async function readSpend(
  sb: SupabaseClient,
  conversationId: string | null,
): Promise<Spend> {
  const { data, error } = await sb
    .rpc("master_ai_spend", { p_conversation_id: conversationId })
    .maybeSingle();
  if (error) throw new Error(`Could not read Master AI spend: ${error.message}`);
  const row = (data ?? {}) as { day_usd?: number | string; conversation_usd?: number | string };
  return {
    // numeric comes back as a string from PostgREST; Number("") is 0, which
    // would silently read as "nothing spent", so default before converting.
    dayUsd: Number(row.day_usd ?? 0),
    conversationUsd: Number(row.conversation_usd ?? 0),
  };
}

/**
 * Whether a turn may start, and how much room it has if so.
 *
 * A limit of 0 stops the Master AI entirely, which is a deliberate off
 * switch rather than a misconfiguration.
 */
export function checkBudget(config: RuntimeConfig, spend: Spend): BudgetVerdict {
  const dayLeft = config.masterAiDailyLimitUsd - spend.dayUsd;
  const conversationLeft = config.masterAiConversationLimitUsd - spend.conversationUsd;

  if (dayLeft <= 0) {
    return {
      ok: false,
      remainingUsd: 0,
      reason:
        `The Master AI has spent ${money(spend.dayUsd)} today, which is its daily limit of ` +
        `${money(config.masterAiDailyLimitUsd)}. It resets at midnight UTC. ` +
        `Raise MASTER_AI_DAILY_LIMIT_USD on the runtime to lift it.`,
    };
  }

  if (conversationLeft <= 0) {
    return {
      ok: false,
      remainingUsd: 0,
      reason:
        `This conversation has cost ${money(spend.conversationUsd)}, which is the per-conversation ` +
        `limit of ${money(config.masterAiConversationLimitUsd)}. Start a new thread to carry on — ` +
        `a long thread also re-sends its history every turn, so a fresh one is cheaper as well as allowed.`,
    };
  }

  // The tighter of the two governs: a turn must not be able to breach the
  // conversation limit just because the day has room, or the reverse.
  return { ok: true, remainingUsd: Math.min(dayLeft, conversationLeft) };
}
