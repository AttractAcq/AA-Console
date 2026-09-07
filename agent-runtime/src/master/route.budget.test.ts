import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The point of these tests is ordering: the ceiling must refuse BEFORE the
// model is called and before anything is written to the thread. Unit tests
// on checkBudget cannot show that — only the wiring can.
const { requireAdmin, runChatTurn, rpc, inserted } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  runChatTurn: vi.fn(),
  rpc: vi.fn(),
  inserted: [] as Array<{ table: string; row: unknown }>,
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return { ...actual, requireAdmin };
});
vi.mock("./chat.js", () => ({ runChatTurn }));

import { handleMasterChat } from "./route.js";
import type { RuntimeConfig } from "../config.js";

function fakeSupabase() {
  const single = () => ({
    select: () => ({
      single: () => {
        const row = { id: "conv-1", created_at: "2026-09-07T10:00:00Z" };
        return Promise.resolve({ data: row, error: null });
      },
    }),
  });
  return {
    rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data:
                table === "master_ai_conversations"
                  ? { id: "conv-1", scope: "company", client_id: null }
                  : { name: "A Client" },
              error: null,
            }),
          order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
        }),
      }),
      insert: (row: unknown) => {
        inserted.push({ table, row });
        return single();
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  } as never;
}

function request(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  stream.headers = { authorization: "Bearer token" };
  return stream;
}

function response() {
  const captured = { status: 0, body: null as Record<string, unknown> | null };
  return {
    res: {
      writeHead: (status: number) => {
        captured.status = status;
      },
      end: (payload: string) => {
        captured.body = JSON.parse(payload) as Record<string, unknown>;
      },
    } as unknown as ServerResponse,
    captured,
  };
}

const config = {
  masterAiDailyLimitUsd: 20,
  masterAiConversationLimitUsd: 5,
  model: "claude-opus-5",
} as RuntimeConfig;

function spendIs(dayUsd: number, conversationUsd: number) {
  rpc.mockReturnValue({
    maybeSingle: () =>
      Promise.resolve({ data: { day_usd: dayUsd, conversation_usd: conversationUsd }, error: null }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  requireAdmin.mockResolvedValue({ userId: "admin-1", email: "a@example.com" });
  runChatTurn.mockResolvedValue({ reply: "done", toolCalls: [], costUsd: 0.09, turns: 1 });
});

describe("the Master AI spend ceiling, in the request path", () => {
  it("runs the turn when there is room", async () => {
    spendIs(1.2, 0.3);
    const { res, captured } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(captured.status).toBe(200);
    expect(runChatTurn).toHaveBeenCalledOnce();
  });

  // The whole point. A ceiling checked after the model call is not a ceiling.
  it("never calls the model once the day is spent", async () => {
    spendIs(20.5, 0.1);
    const { res, captured } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(captured.status).toBe(429);
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(String(captured.body?.error)).toMatch(/daily limit/i);
  });

  it("never calls the model once one conversation has run away", async () => {
    spendIs(6, 5.4);
    const { res, captured } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(captured.status).toBe(429);
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(String(captured.body?.error)).toMatch(/per-conversation/i);
  });

  // A refused turn must leave no trace in the thread, or the history fills
  // with questions that were never answered.
  it("writes nothing to the conversation when it refuses", async () => {
    spendIs(20.5, 0.1);
    const { res } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(inserted.filter((i) => i.table === "master_ai_messages")).toHaveLength(0);
  });

  it("hands the turn only the headroom that is actually left", async () => {
    spendIs(1, 4.6);
    const { res } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    // The conversation is the tighter of the two: $5.00 - $4.60.
    const opts = runChatTurn.mock.calls[0]?.[0] as { budgetRemainingUsd: number } | undefined;
    expect(opts?.budgetRemainingUsd).toBeCloseTo(0.4);
  });

  it("reports spend and limits back so the console can show them", async () => {
    spendIs(1.2, 0.3);
    const { res, captured } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(captured.body?.spend).toEqual({ day_usd: 1.29, conversation_usd: 0.39 });
    expect(captured.body?.limits).toEqual({ day_usd: 20, conversation_usd: 5 });
  });

  // A ceiling that fails open is not a ceiling. If the total cannot be read,
  // the turn must not run.
  it("refuses rather than proceeding when spend cannot be read", async () => {
    rpc.mockReturnValue({
      maybeSingle: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
    });
    const { res, captured } = response();
    await handleMasterChat(request({ conversation_id: "conv-1", message: "hi" }), res, fakeSupabase(), config);

    expect(captured.status).toBe(500);
    expect(runChatTurn).not.toHaveBeenCalled();
  });
});
