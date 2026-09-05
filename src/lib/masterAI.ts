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

export interface MasterReply {
  conversationId: string;
  reply: string;
  toolCalls: ToolCall[];
  costUsd: number;
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

  const body = (await response.json().catch(() => null)) as
    | { ok: boolean; error?: string; conversation_id?: string; reply?: string; tool_calls?: ToolCall[]; cost_usd?: number }
    | null;

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error ?? `The runtime returned ${response.status}.`);
  }

  return {
    conversationId: body.conversation_id as string,
    reply: body.reply ?? "",
    toolCalls: body.tool_calls ?? [],
    costUsd: body.cost_usd ?? 0,
  };
}
