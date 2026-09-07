import { supabase } from "./supabase";

/**
 * Client for the Master AI endpoint on the agent runtime.
 *
 * The runtime holds the service role key, so it re-verifies the caller's
 * access token and admin role on every request. Nothing here is a security
 * boundary — hiding the UI keeps non-admins from stumbling into it, but the
 * refusal that matters happens on the server.
 */

export type MasterScope = { kind: "company" } | { kind: "client"; clientId: string };

export interface ToolCall {
  tool: string;
  input: unknown;
  summary: string;
  mutating: boolean;
}

export interface MasterSpend {
  dayUsd: number;
  conversationUsd: number;
}

export interface MasterLimits {
  dayUsd: number;
  conversationUsd: number;
}

export interface MasterReply {
  conversationId: string;
  reply: string;
  toolCalls: ToolCall[];
  costUsd: number;
  /** True when the runtime cut the turn short at the spend ceiling. */
  stoppedForBudget: boolean;
  spend: MasterSpend | null;
  /**
   * The runtime's ceilings, which live in its environment rather than the
   * database. The console learns them from a reply rather than mirroring
   * them in its own config, where the two would drift apart unnoticed.
   */
  limits: MasterLimits | null;
}

/**
 * Master AI spend so far, read from the same function the runtime enforces
 * against. Admin-only at the database, so this returns zeroes rather than
 * throwing for anyone else — a budget line is not worth an error state.
 */
export async function readMasterSpend(conversationId: string | null): Promise<MasterSpend> {
  const { data, error } = await supabase
    // The RPC defaults this, so an absent conversation must be undefined
    // rather than null or the generated types reject the call.
    .rpc("master_ai_spend", { p_conversation_id: conversationId ?? undefined })
    .maybeSingle();
  if (error || !data) return { dayUsd: 0, conversationUsd: 0 };
  const row = data as { day_usd: number | string; conversation_usd: number | string };
  return { dayUsd: Number(row.day_usd ?? 0), conversationUsd: Number(row.conversation_usd ?? 0) };
}

const RUNTIME_URL = (import.meta.env.VITE_AGENT_RUNTIME_URL as string | undefined)?.replace(
  /\/+$/,
  "",
);

export function masterAIConfigured(): boolean {
  return Boolean(RUNTIME_URL);
}

export async function sendMasterMessage(opts: {
  scope: MasterScope;
  conversationId: string | null;
  message: string;
  signal?: AbortSignal;
}): Promise<MasterReply> {
  if (!RUNTIME_URL) {
    throw new Error(
      "The agent runtime address is not set. Add VITE_AGENT_RUNTIME_URL to your environment.",
    );
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired. Sign in again.");

  const response = await fetch(`${RUNTIME_URL}/master/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    signal: opts.signal,
    body: JSON.stringify({
      conversation_id: opts.conversationId,
      scope: opts.scope.kind,
      client_id: opts.scope.kind === "client" ? opts.scope.clientId : undefined,
      message: opts.message,
    }),
  });

  type Money = { day_usd?: number; conversation_usd?: number };
  const body = (await response.json().catch(() => null)) as
    | {
        ok: boolean;
        error?: string;
        conversation_id?: string;
        reply?: string;
        tool_calls?: ToolCall[];
        cost_usd?: number;
        stopped_for_budget?: boolean;
        spend?: Money;
        limits?: Money;
      }
    | null;

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error ?? `The runtime returned ${response.status}.`);
  }

  const money = (m: Money | undefined): MasterSpend | null =>
    m ? { dayUsd: Number(m.day_usd ?? 0), conversationUsd: Number(m.conversation_usd ?? 0) } : null;

  return {
    conversationId: body.conversation_id as string,
    reply: body.reply ?? "",
    toolCalls: body.tool_calls ?? [],
    costUsd: body.cost_usd ?? 0,
    stoppedForBudget: body.stopped_for_budget ?? false,
    spend: money(body.spend),
    limits: money(body.limits),
  };
}
