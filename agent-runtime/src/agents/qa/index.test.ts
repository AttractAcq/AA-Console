import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";
import { MAX_QA_REBUILDS, nextStage, runQaJob } from "./index.js";
import type { Finding } from "./checks.js";

const SLOT = {
  id: "slot-1",
  client_id: "client-1",
  stage: "qa",
  format: "single",
  platform: "instagram",
  scheduled_at: "2026-11-02T09:00:00Z",
  pillar_id: "p1",
  idea_id: "i1",
  brief_id: "brief-1",
  asset_id: "asset-1",
  attempts: 0,
};

const config = {} as RuntimeConfig;
const agent = { agent_key: "qa" } as unknown as AgentRow;
const job = {
  id: "job-1",
  client_id: "client-1",
  input_table: "content_slots",
  input_id: "slot-1",
  params: { slot_id: "slot-1", source: "engine" },
} as unknown as AgentJobRow;

const CLEAN_COPY = {
  caption: "Five steps, one chain.",
  hashtags: ["#proof"],
  alt_text: "Cards in a row.",
  link_url: null,
  first_comment: null,
  cta: null,
};

function database(
  options: {
    slot?: unknown;
    copy?: unknown;
    neverDo?: string;
    asset?: unknown;
    threshold?: number;
    proofCount?: number;
  } = {},
) {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const events: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    const data =
      table === "content_slots"
        ? ("slot" in options ? options.slot : SLOT)
        : table === "post_copy"
          ? ("copy" in options ? options.copy : CLEAN_COPY)
          : table === "client_brand_profiles"
            ? { never_do: options.neverDo ?? "" }
            : table === "client_briefs"
              ? {
                  title: "The Chain",
                  // Carries a figure on purpose: the no-proof warning only
                  // fires when the brief has something to stand up.
                  hook: "We lifted bookings 30% in a quarter.",
                  call_to_action: "Ask one question.",
                }
              : table === "client_media_assets"
                ? ("asset" in options ? options.asset : { width: 1080, height: 1080, duration_sec: null })
                : table === "client_engine_settings"
                  ? { min_qa_score: options.threshold ?? 70 }
                  : null;

    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ count: options.proofCount ?? 1, data, error: null }).then(resolve),
    });
    return chain;
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, events };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  area: "brand",
  severity: "blocker",
  detail: "x",
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("where a slot goes next", () => {
  it("goes for approval when it clears the threshold with nothing blocking", () => {
    expect(nextStage(100, 70, 0, []).stage).toBe("awaiting_approval");
    expect(nextStage(70, 70, 0, []).stage).toBe("awaiting_approval");
  });

  it("refuses approval on any blocker, however well it scores", () => {
    // One banned phrase costs 25 and leaves 75, which clears a threshold of
    // 70. On score alone, a post saying the one thing the brand forbids
    // would reach a person marked "passed QA".
    expect(nextStage(75, 70, 0, [finding({ severity: "blocker" })]).stage).not.toBe("awaiting_approval");
    expect(nextStage(92, 70, 0, [finding({ severity: "blocker" })]).stage).toBe("copywriting");
  });

  it("still approves when only warnings were raised", () => {
    expect(nextStage(92, 70, 0, [finding({ severity: "warning" })]).stage).toBe("awaiting_approval");
  });

  it("sends the words back when the words are the problem", () => {
    // Rebuilding an image because a caption broke a rule spends the
    // expensive half on the cheap half's problem.
    const { stage } = nextStage(50, 70, 0, [finding({ area: "brand" })]);
    expect(stage).toBe("copywriting");
  });

  it("sends the asset back when the asset is the problem", () => {
    const { stage } = nextStage(50, 70, 0, [
      finding({ area: "platform", detail: "A reel has to be 9:16. This is 1080×1080." }),
    ]);
    expect(stage).toBe("building");
  });

  it("gives up after two rebuilds rather than billing for a third", () => {
    expect(nextStage(50, 70, MAX_QA_REBUILDS, [finding()]).stage).toBe("failed");
    expect(nextStage(50, 70, MAX_QA_REBUILDS + 1, [finding()]).stage).toBe("failed");
  });

  it("says the score and what it found, whichever way it went", () => {
    expect(nextStage(100, 70, 0, []).note).toMatch(/Passed QA at 100\/100/);
    expect(nextStage(50, 70, 0, [finding()]).note).toMatch(/50\/100.*1 blocker/);
    expect(nextStage(50, 70, 2, [finding()]).note).toMatch(/after 2 rebuilds/);
  });
});

describe("the QA pass", () => {
  it("records the score and sends a clean slot for approval", async () => {
    const { sb, rpc } = database();
    const result = await runQaJob(sb, config, agent, job);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "record_qa_result",
      expect.objectContaining({
        p_slot_id: "slot-1",
        p_score: 100,
        p_to_stage: "awaiting_approval",
        p_findings: [],
      }),
    );
  });

  it("writes the findings with the move, not separately", async () => {
    // A slot that advanced without its findings would show a person a clean
    // card for something QA objected to.
    const { sb, rpc } = database({ neverDo: "world class", copy: { ...CLEAN_COPY, caption: "We are world class." } });
    await runQaJob(sb, config, agent, job);
    const [, args] = rpc.mock.calls[0] as [string, { p_findings: Finding[]; p_to_stage: string }];
    expect(args.p_findings).toHaveLength(1);
    expect(args.p_to_stage).toBe("copywriting");
  });

  it("honours the client's own threshold", async () => {
    // One warning costs 8. At a threshold of 95 that is a fail; at 70 it is not.
    const lenient = database({ proofCount: 0, threshold: 70 });
    await runQaJob(lenient.sb, config, agent, job);
    expect((lenient.rpc.mock.calls[0]![1] as { p_to_stage: string }).p_to_stage).toBe("awaiting_approval");

    const strict = database({ proofCount: 0, threshold: 95 });
    await runQaJob(strict.sb, config, agent, job);
    expect((strict.rpc.mock.calls[0]![1] as { p_to_stage: string }).p_to_stage).toBe("copywriting");
  });

  it("flags a reel that is not 9:16", async () => {
    const { sb, rpc } = database({
      slot: { ...SLOT, format: "reel" },
      asset: { width: 1080, height: 1080, duration_sec: 20, render_path: "cuts/a.mp4" },
    });
    await runQaJob(sb, config, agent, job);
    const args = rpc.mock.calls[0]![1] as { p_findings: Finding[]; p_to_stage: string };
    expect(args.p_findings.some((f) => f.detail.includes("9:16"))).toBe(true);
    // An asset problem goes back to the builder, not the writer.
    expect(args.p_to_stage).toBe("building");
  });

  it("says nothing about dimensions that were never recorded", async () => {
    const { sb, rpc } = database({
      slot: { ...SLOT, format: "reel" },
      // Cut, but before migration 158 added the dimension columns — which is
      // the state the one real cut in production is in.
      asset: { width: null, height: null, duration_sec: null, render_path: "cuts/a.mp4" },
    });
    await runQaJob(sb, config, agent, job);
    expect((rpc.mock.calls[0]![1] as { p_score: number }).p_score).toBe(100);
  });

  it("refuses to send an uncut reel for approval, and sends it back to be built", async () => {
    // The whole point of the editing stage: clips are not a cut, and with
    // every dimension null nothing else in QA would have fired.
    const { sb, rpc } = database({
      slot: { ...SLOT, format: "reel" },
      asset: { width: null, height: null, duration_sec: null, render_path: null },
    });
    await runQaJob(sb, config, agent, job);
    const args = rpc.mock.calls[0]![1] as { p_to_stage: string; p_findings: { detail: string }[] };
    expect(args.p_to_stage).not.toBe("awaiting_approval");
    expect(args.p_findings.some((f) => /clips but no cut/.test(f.detail))).toBe(true);
  });

  it("refuses a slot with no copy rather than passing it", async () => {
    // Copy is most of what QA checks. Passing a slot with none would be
    // approving a post with no words.
    const { sb, rpc } = database({ copy: null });
    const result = await runQaJob(sb, config, agent, job);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.failureMessage).toMatch(/no instagram copy/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a slot with no asset", async () => {
    const { sb } = database({ slot: { ...SLOT, asset_id: null } });
    const result = await runQaJob(sb, config, agent, job);
    expect(result.failureMessage).toMatch(/no asset/);
  });

  it("refuses a job with no slot", async () => {
    const { sb } = database();
    const result = await runQaJob(sb, config, agent, { ...job, params: {} } as unknown as AgentJobRow);
    expect(result.failureMessage).toMatch(/only runs for a slot/);
  });

  it("gives the same answer twice for the same post", async () => {
    // The number decides whether a client's money is spent again.
    const a = database({ neverDo: "world class", copy: { ...CLEAN_COPY, caption: "We are world class." } });
    const b = database({ neverDo: "world class", copy: { ...CLEAN_COPY, caption: "We are world class." } });
    await runQaJob(a.sb, config, agent, job);
    await runQaJob(b.sb, config, agent, job);
    expect(b.rpc.mock.calls[0]![1]).toEqual(a.rpc.mock.calls[0]![1]);
  });
});
