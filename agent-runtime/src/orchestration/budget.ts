import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether a client's agents may spend anything more this month.
 *
 * Checked in dispatchJob rather than in each runner, for the same reason the
 * deadline is: an agent added later is bounded whether or not it thinks to
 * ask. A runner that forgets cannot be the gap.
 *
 * Off unless switched on. No row in client_engine_budgets means no cap, and
 * `capped: false` is what the database returns for that — distinct from a
 * cap of zero, which is a real instruction meaning stop. Treating a missing
 * cap as zero would stop every client at once the moment this shipped.
 *
 * A read failure does not stop work. The cap is a cost control, not a safety
 * interlock, and refusing every job in the queue because one SELECT timed out
 * would turn a budgeting feature into an outage.
 */

export interface BudgetDecision {
  allowed: boolean;
  /** Present only when refused, and written for the person who reads the job. */
  message?: string;
}

interface BudgetRow {
  capped: boolean | null;
  cap_usd: number | string | null;
  spent_usd: number | string | null;
  remaining_usd: number | string | null;
}

const money = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const usd = (value: number): string => `$${value.toFixed(2)}`;

export async function checkClientBudget(
  sb: SupabaseClient,
  clientId: string | null | undefined,
): Promise<BudgetDecision> {
  // House jobs with no client have nothing to charge against.
  if (!clientId) return { allowed: true };

  let data: unknown;
  try {
    const result = await sb.rpc("client_budget_state", { p_client_id: clientId });
    if (result.error) return { allowed: true };
    data = result.data;
  } catch {
    // A throw, not just a returned error: an rpc that is missing, a transport
    // that is down, a client stubbed without it. Same answer either way — the
    // cap is a cost control, and letting it take dispatch down with it would
    // be a worse failure than the one it exists to prevent.
    return { allowed: true };
  }

  const row = (Array.isArray(data) ? data[0] : data) as BudgetRow | null | undefined;
  if (!row || row.capped !== true) return { allowed: true };

  const cap = money(row.cap_usd);
  const spent = money(row.spent_usd) ?? 0;
  if (cap === null) return { allowed: true };
  if (spent < cap) return { allowed: true };

  return {
    allowed: false,
    message:
      `This client has spent ${usd(spent)} of its ${usd(cap)} cap for the month, ` +
      `so no further agent work was started. Raise the cap in Account to continue.`,
  };
}
