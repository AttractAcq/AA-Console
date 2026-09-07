import { describe, expect, it, vi } from "vitest";
import { checkBudget, readSpend, type Spend } from "./budget.js";
import type { RuntimeConfig } from "../config.js";

const config = (day: number, conversation: number) =>
  ({ masterAiDailyLimitUsd: day, masterAiConversationLimitUsd: conversation }) as RuntimeConfig;

const spend = (dayUsd: number, conversationUsd = 0): Spend => ({ dayUsd, conversationUsd });

describe("checkBudget", () => {
  it("allows a turn well inside both limits", () => {
    const verdict = checkBudget(config(20, 5), spend(1.1, 0.3));
    expect(verdict.ok).toBe(true);
  });

  // The tighter limit governs. A turn must not be able to breach the
  // conversation ceiling just because the day still has room.
  it("gives the turn the smaller of the two headrooms", () => {
    expect(checkBudget(config(20, 5), spend(1, 4.5)).remainingUsd).toBeCloseTo(0.5);
    expect(checkBudget(config(20, 5), spend(19.8, 0)).remainingUsd).toBeCloseTo(0.2);
  });

  it("refuses once the day is spent, and says when it resets", () => {
    const verdict = checkBudget(config(20, 5), spend(20));
    expect(verdict.ok).toBe(false);
    expect(verdict.remainingUsd).toBe(0);
    expect(verdict.reason).toMatch(/daily limit/i);
    expect(verdict.reason).toMatch(/midnight UTC/);
  });

  it("refuses a conversation that has run in circles, while the day still has room", () => {
    const verdict = checkBudget(config(20, 5), spend(6, 5.2));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/per-conversation limit/i);
    expect(verdict.reason).toMatch(/new thread/i);
  });

  // Which limit was hit changes what the operator should do — start a new
  // thread, or wait until tomorrow — so the two messages must not be swapped.
  it("names the daily limit first when both are breached", () => {
    const verdict = checkBudget(config(20, 5), spend(25, 9));
    expect(verdict.reason).toMatch(/daily limit/i);
  });

  it("reports the actual figures, not just that a limit exists", () => {
    const verdict = checkBudget(config(20, 5), spend(20.5));
    expect(verdict.reason).toContain("$20.50");
    expect(verdict.reason).toContain("$20.00");
  });

  it("treats exactly at the limit as spent, not as room for one more", () => {
    expect(checkBudget(config(20, 5), spend(20)).ok).toBe(false);
    expect(checkBudget(config(20, 5), spend(19.99)).ok).toBe(true);
  });

  // A deliberate off switch rather than a misconfiguration.
  it("stops the Master AI entirely at a limit of zero", () => {
    expect(checkBudget(config(0, 5), spend(0)).ok).toBe(false);
  });

  it("is not confused by a fresh conversation with no spend", () => {
    const verdict = checkBudget(config(20, 5), spend(0, 0));
    expect(verdict.ok).toBe(true);
    expect(verdict.remainingUsd).toBeCloseTo(5);
  });
});

describe("readSpend", () => {
  const sbWith = (data: unknown, error: { message: string } | null = null) =>
    ({ rpc: vi.fn(() => ({ maybeSingle: () => Promise.resolve({ data, error }) })) }) as never;

  it("asks the database for the totals rather than counting locally", async () => {
    const sb = sbWith({ day_usd: "1.2500", conversation_usd: "0.4400" });
    const result = await readSpend(sb, "conv-1");
    expect(result).toEqual({ dayUsd: 1.25, conversationUsd: 0.44 });
  });

  // PostgREST returns numeric as a string. Number("") is 0, so a missing
  // field must default before conversion or an unreadable total silently
  // reads as "nothing spent" — the one wrong answer a ceiling must never give.
  it("does not read a missing total as zero spend by accident", async () => {
    const result = await readSpend(sbWith({}), null);
    expect(result).toEqual({ dayUsd: 0, conversationUsd: 0 });
  });

  it("fails loudly rather than returning zero when the read errors", async () => {
    await expect(readSpend(sbWith(null, { message: "permission denied" }), "c")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("passes the conversation id through so the per-thread total is real", async () => {
    const sb = sbWith({ day_usd: 0, conversation_usd: 0 });
    await readSpend(sb, "conv-9");
    expect((sb as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "master_ai_spend",
      { p_conversation_id: "conv-9" },
    );
  });
});
