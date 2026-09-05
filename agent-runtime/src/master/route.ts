// HTTP surface for the Master AI.
//
// The scope a turn runs under is read from the conversation row every time,
// never from the request body. A caller who forges scope:"company" on an
// existing client conversation still gets the client scope, because the
// body is only consulted when a conversation is first created.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { logger } from "../logging/logger.js";
import { AuthError, requireAdmin } from "./auth.js";
import { runChatTurn } from "./chat.js";
import type { MasterScope } from "./scope.js";

const MAX_BODY_BYTES = 64 * 1024;
const HISTORY_LIMIT = 40;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AuthError("Request body too large.", 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AuthError("Body must be JSON.", 400);
  }
}

export async function handleMasterChat(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    const caller = await requireAdmin(sb, req.headers.authorization);
    const body = await readBody(req);

    const message = String(body.message ?? "").trim();
    if (!message) return json(400, { ok: false, error: "Say something." });

    // --- resolve the conversation, and with it the authoritative scope ---
    let conversationId = body.conversation_id ? String(body.conversation_id) : null;
    let scope: MasterScope;
    let clientName: string | null = null;

    if (conversationId) {
      const { data: convo, error } = await sb
        .from("master_ai_conversations")
        .select("id, scope, client_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!convo) return json(404, { ok: false, error: "No such conversation." });
      scope =
        convo.scope === "client"
          ? { kind: "client", clientId: convo.client_id as string }
          : { kind: "company" };
    } else {
      const requested = String(body.scope ?? "company");
      if (requested === "client") {
        const clientId = body.client_id ? String(body.client_id) : null;
        if (!clientId) return json(400, { ok: false, error: "A client conversation needs a client_id." });
        scope = { kind: "client", clientId };
      } else {
        scope = { kind: "company" };
      }
      const { data: created, error } = await sb
        .from("master_ai_conversations")
        .insert({
          scope: scope.kind,
          client_id: scope.kind === "client" ? scope.clientId : null,
          created_by: caller.userId,
          title: message.slice(0, 80),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      conversationId = created.id as string;
    }

    if (scope.kind === "client") {
      const { data: client } = await sb
        .from("clients")
        .select("name")
        .eq("id", scope.clientId)
        .maybeSingle();
      if (!client) return json(404, { ok: false, error: "No such client." });
      clientName = client.name as string;
    }

    // --- record the operator's message before doing anything with it ----
    const { data: userMessage, error: insertError } = await sb
      .from("master_ai_messages")
      .insert({ conversation_id: conversationId, role: "user", content: message })
      .select("created_at")
      .single();
    if (insertError) throw new Error(insertError.message);

    const { data: rows, error: historyError } = await sb
      .from("master_ai_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (historyError) throw new Error(historyError.message);
    const history = (rows ?? [])
      .reverse()
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content as string }))
      .filter((r) => r.content.trim().length > 0);

    const started = Date.now();
    const result = await runChatTurn({
      sb,
      config,
      scope,
      conversationId,
      clientName,
      history,
      lastUserMessageAt: userMessage.created_at as string,
      actorId: caller.userId,
    });

    await sb.from("master_ai_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: result.reply,
      tool_calls: result.toolCalls,
      cost_usd: result.costUsd,
    });
    await sb
      .from("master_ai_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    logger.info("master_ai_turn", {
      conversationId,
      scope: scope.kind,
      clientId: scope.kind === "client" ? scope.clientId : null,
      userId: caller.userId,
      turns: result.turns,
      tools: result.toolCalls.length,
      mutations: result.toolCalls.filter((t) => t.mutating).length,
      costUsd: result.costUsd,
      ms: Date.now() - started,
    });

    json(200, {
      ok: true,
      conversation_id: conversationId,
      reply: result.reply,
      tool_calls: result.toolCalls,
      cost_usd: result.costUsd,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(error.status, { ok: false, error: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("master_ai_request_failed", { error: message });
    json(500, { ok: false, error: message });
  }
}
