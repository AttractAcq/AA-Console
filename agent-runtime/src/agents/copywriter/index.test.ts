import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../../config.js";
import type { AgentRow } from "../../orchestration/registry.js";
import type { AgentJobRow } from "../../queue.js";

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../../tools/anthropic.js", async () => ({
  ...(await vi.importActual("../../tools/anthropic.js")),
  runAgentLoop: model,
}));
vi.mock("../shared.js", () => ({ loadUpstreamRecords: async () => [] }));
vi.mock("../identity.js", () => ({
  loadIdentity: async () => ({ businessName: "Harbour" }),
  identityWriterBlock: () => "IDENTITY",
}));

import { copyProblems, parseCopy, runCopywriterJob } from "./index.js";

const SLOT = {
  id: "slot-1",
  client_id: "client-1",
  stage: "copywriting",
  format: "single",
  platform: "instagram",
  scheduled_at: "2026-11-02T09:00:00Z",
  pillar_id: "pillar-1",
  idea_id: "idea-1",
  brief_id: "brief-1",
  asset_id: "asset-1",
  attempts: 0,
};

const config = { anthropicApiKeyByAgent: {}, anthropicApiKey: "k", model: "m" } as unknown as RuntimeConfig;
const agent = { agent_key: "copywriter", name: "Copywriter" } as unknown as AgentRow;
const job = {
  id: "job-1",
  client_id: "client-1",
  input_table: "content_slots",
  input_id: "slot-1",
  params: { slot_id: "slot-1", source: "engine" },
} as unknown as AgentJobRow;

function database(options: { slot?: unknown; neverDo?: string } = {}) {
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
        ? "slot" in options
          ? options.slot
          : SLOT
        : table === "client_briefs"
          ? { title: "The Chain", hook: "Thirty posts.", call_to_action: "Ask one question." }
          : table === "client_brand_profiles"
            ? { never_do: options.neverDo ?? "" }
            : { name: "Harbour" };
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) };
  });
  return { sb: { from, rpc } as unknown as SupabaseClient, rpc, events };
}

const GOOD = {
  caption: "Five steps, one chain. That is the whole argument.",
  hashtags: ["#agency", "proof"],
  alt_text: "Five cards joined by a line.",
  first_comment: "The full breakdown is in the bio.",
  cta: "Ask one question.",
};

function modelReturns(...drafts: Record<string, unknown>[]) {
  model.mockReset();
  for (const draft of drafts) {
    model.mockResolvedValueOnce({ submitted: draft, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 } });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  modelReturns(GOOD);
});

describe("parseCopy", () => {
  it("trims, and keeps only hashtags that are strings", () => {
    expect(parseCopy({ caption: "  hi  ", hashtags: ["#a", 7, "", " b "], alt_text: null })).toEqual({
      caption: "hi",
      hashtags: ["#a", "b"],
      alt_text: "",
      first_comment: "",
      cta: "",
    });
  });

  it("survives a model that submitted nothing at all", () => {
    expect(parseCopy(undefined)).toEqual({
      caption: "",
      hashtags: [],
      alt_text: "",
      first_comment: "",
      cta: "",
    });
  });
});

describe("copyProblems", () => {
  it("passes copy that fits", () => {
    expect(copyProblems("instagram", parseCopy(GOOD), [])).toEqual([]);
  });

  it("refuses copy with no caption at all", () => {
    expect(copyProblems("instagram", parseCopy({ ...GOOD, caption: "" }), [])).toContain("There is no caption.");
  });

  it("applies the platform's own limits", () => {
    const problems = copyProblems("instagram", parseCopy({ ...GOOD, caption: "x".repeat(2300) }), []);
    expect(problems.join(" ")).toMatch(/2,200/);
  });

  it("catches a banned phrase wherever it is hiding", () => {
    // Caught here as well as in QA: now it costs one revise, later a rebuild.
    for (const field of ["caption", "first_comment", "cta"] as const) {
      const problems = copyProblems("instagram", parseCopy({ ...GOOD, [field]: "we are world class" }), [
        "world class",
      ]);
      expect(problems.join(" ")).toMatch(/world class/);
    }
  });

  it("catches a banned phrase in a hashtag", () => {
    const problems = copyProblems("instagram", parseCopy({ ...GOOD, hashtags: ["#worldclass"] }), ["worldclass"]);
    expect(problems.join(" ")).toMatch(/worldclass/);
  });
});

describe("the copywriter", () => {
  it("files the copy against the asset, because there is no post yet", async () => {
    const { sb, rpc } = database();
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "set_post_copy",
      expect.objectContaining({
        p_platform: "instagram",
        p_asset_id: "asset-1",
        p_caption: GOOD.caption,
        p_source: "agent",
      }),
    );
  });

  it("sends the slot on to QA, with what it cost", async () => {
    const { sb, rpc } = database();
    await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(rpc).toHaveBeenCalledWith(
      "advance_slot",
      expect.objectContaining({ p_to_stage: "qa", p_agent_key: "copywriter", p_cost_usd: 0.02 }),
    );
  });

  it("tells the model the platform's real limits", async () => {
    const { sb } = database();
    await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    const [{ prompt, system }] = model.mock.calls[0] as [{ prompt: string; system: string }];
    expect(prompt).toContain("2200");
    expect(prompt).toContain("Instagram");
    // The rule about links is a standing instruction, so it lives in the
    // system message rather than being repeated with the brief.
    expect(system).toMatch(/not clickable/);
  });

  it("asks once for a fix, then uses the fixed draft", async () => {
    modelReturns({ ...GOOD, caption: "x".repeat(2300) }, GOOD);
    const { sb, rpc } = database();
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(model).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    // Both calls are charged for.
    expect(result.usage?.costUsd).toBeCloseTo(0.04, 5);
    expect(rpc).toHaveBeenCalledWith("set_post_copy", expect.objectContaining({ p_caption: GOOD.caption }));
  });

  it("refuses after the second failure rather than trying a third time", async () => {
    const tooLong = { ...GOOD, caption: "x".repeat(2300) };
    modelReturns(tooLong, tooLong);
    const { sb, rpc } = database();
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(model).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(rpc).not.toHaveBeenCalledWith("set_post_copy", expect.anything());
    // The slot is not sent to QA with copy that does not fit.
    expect(rpc).not.toHaveBeenCalledWith("advance_slot", expect.anything());
  });

  it("will not write copy about an asset that does not exist yet", async () => {
    const { sb } = database({ slot: { ...SLOT, asset_id: null } });
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.failureMessage).toMatch(/no asset yet/);
    expect(model).not.toHaveBeenCalled();
  });

  it("refuses a platform it has no limits for, rather than guessing them", async () => {
    const { sb } = database({ slot: { ...SLOT, platform: "threads" } });
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);
    expect(result.failureMessage).toMatch(/no limits on file/);
    expect(model).not.toHaveBeenCalled();
  });

  it("refuses a job with no slot", async () => {
    const { sb } = database();
    const result = await runCopywriterJob(
      sb,
      config,
      agent,
      { ...job, params: {} } as unknown as AgentJobRow,
      Date.now() + 60_000,
    );
    expect(result.failureMessage).toMatch(/only runs for a slot/);
    expect(model).not.toHaveBeenCalled();
  });

  it("passes the brand's banned phrases to the model and enforces them itself", async () => {
    modelReturns({ ...GOOD, caption: "We are world class at this." }, GOOD);
    const { sb } = database({ neverDo: "world class\nbest in the business" });
    const result = await runCopywriterJob(sb, config, agent, job, Date.now() + 60_000);

    const [{ prompt }] = model.mock.calls[0] as [{ prompt: string }];
    expect(prompt).toContain("THE BRAND NEVER SAYS");
    expect(prompt).toContain("world class");
    // And the first draft was rejected for using it.
    const [, second] = model.mock.calls as [unknown, [{ prompt: string }]];
    expect(second[0].prompt).toMatch(/world class/);
    expect(result.ok).toBe(true);
  });
});
