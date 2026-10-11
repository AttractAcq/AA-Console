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
vi.mock("../shared.js", () => ({ loadUpstreamRecords: async () => UPSTREAM }));

import { runIdeationJob } from "./index.js";
import { SLOT_IDEA_COUNT } from "../../engine/slot.js";

/**
 * Ideation when the engine asked for it.
 *
 * The acceptance for M3.5 is that the ideas cite the slot's pillar and
 * format, and that a slot asks for a handful rather than a bank. All three
 * are properties of what gets written, so they are asserted on the rows that
 * reach client_ideas rather than on the prompt alone.
 */

// Enough of a corpus that the agent's own guards pass and the run reaches
// the model. The question universe is the one it refuses to run without.
const UPSTREAM = [
  {
    domain: "icp",
    item_key: "question-universe",
    title: "Question universe",
    body: "Why does content not compound? What should an agency prove?",
  },
  { domain: "icp", item_key: "objections", title: "Objections", body: "We tried an agency before." },
  { domain: "brand_strategy", item_key: "territories", title: "Territories", body: "Proof. The chain." },
  { domain: "offer_strategy", item_key: "dream-outcome", title: "Dream outcome", body: "Content that compounds." },
];

const SLOT = {
  id: "slot-1",
  client_id: "client-1",
  stage: "ideating",
  format: "reel",
  platform: "instagram",
  scheduled_at: "2026-11-02T09:00:00Z",
  pillar_id: "pillar-1",
  idea_id: null,
  brief_id: null,
  asset_id: null,
  attempts: 0,
};

const PILLAR = {
  id: "pillar-1",
  name: "Proof",
  premise: "Show the work.",
  belongs: "Evidence.",
  does_not_belong: "Opinion.",
  active: true,
};

const config = { anthropicApiKeyByAgent: {}, anthropicApiKey: "test", model: "m" } as unknown as RuntimeConfig;
const agent = { agent_key: "ideation", name: "Ideation", config: {} } as unknown as AgentRow;

const engineJob = {
  id: "job-1",
  client_id: "client-1",
  input_table: "content_slots",
  input_id: "slot-1",
  params: { slot_id: "slot-1", source: "engine" },
} as unknown as AgentJobRow;

const handJob = {
  id: "job-2",
  client_id: "client-1",
  input_table: null,
  input_id: null,
  params: {},
} as unknown as AgentJobRow;

function database(options: { slot?: unknown; pillar?: unknown } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    if (table === "client_ideas") {
      return {
        insert: vi.fn(async (rows: Record<string, unknown>[]) => {
          inserted.push(...rows);
          return { error: null };
        }),
      };
    }
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      eq: () => query,
      neq: () => query,
      is: () => query,
      order: () => query,
      limit: () => query,
      insert: vi.fn(async () => ({ error: null })),
      maybeSingle: async () => ({
        error: null,
        data:
          table === "content_slots"
            ? ("slot" in options ? options.slot : SLOT)
            : table === "client_content_pillars"
              ? ("pillar" in options ? options.pillar : PILLAR)
              : null,
      }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "client_content_pillars" ? [] : [],
          error: null,
        }).then(resolve),
    });
    return query;
  });
  return { sb: { from } as unknown as SupabaseClient, inserted };
}

/** What the model hands back: one well-formed idea, in the wrong shape. */
function modelReturns(count: number, format = "single", media = "image") {
  model.mockResolvedValue({
    submitted: {
      ideas: Array.from({ length: count }, (_, i) => ({
        title: `Idea ${i + 1}`,
        core_idea: "A thing worth saying.",
        content_territory: "Proof",
        source_question: "Why does content not compound?",
        strategic_reason: "It answers the question.",
        media_type: media,
        content_format: format,
      })),
    },
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  modelReturns(SLOT_IDEA_COUNT);
});

describe("ideation for a slot", () => {
  it("asks for a handful of ideas, not a bank", async () => {
    const { sb } = database();
    await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);

    const [{ prompt, submitTool }] = model.mock.calls[0] as [{ prompt: string; submitTool: { description: string } }];
    expect(prompt).toContain(`idea bank of ${SLOT_IDEA_COUNT} ideas`);
    expect(submitTool.description).toContain(String(SLOT_IDEA_COUNT));
    // Not the unscoped default.
    expect(prompt).not.toContain("25 ideas");
  });

  it("tells the model the platform and the shape, and that the shape is settled", async () => {
    const { sb } = database();
    await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    const [{ prompt }] = model.mock.calls[0] as [{ prompt: string }];
    expect(prompt).toContain("instagram");
    expect(prompt).toContain("reel");
    expect(prompt).toMatch(/not yours to change/);
  });

  it("scopes the run to the slot's pillar", async () => {
    const { sb, inserted } = database();
    await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    const [{ prompt }] = model.mock.calls[0] as [{ prompt: string }];
    expect(prompt).toContain("Proof");
    expect(inserted.every((row) => row.pillar_id === "pillar-1")).toBe(true);
  });

  it("writes the slot's format, not the one the model chose", async () => {
    // The planner picked the format from the client's mix and the calendar.
    // An idea arriving as something else is the model having a view about a
    // decision already taken.
    modelReturns(SLOT_IDEA_COUNT, "single");
    const { sb, inserted } = database();
    await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    expect(inserted).toHaveLength(SLOT_IDEA_COUNT);
    expect(inserted.every((row) => row.content_format === "reel")).toBe(true);
  });

  it("points every idea back at the slot it was asked for", async () => {
    const { sb, inserted } = database();
    await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    expect(inserted.every((row) => row.slot_id === "slot-1")).toBe(true);
    expect(inserted.every((row) => row.source === "pillar")).toBe(true);
  });

  it("refuses a job that names a slot which is gone", async () => {
    const { sb } = database({ slot: null });
    const result = await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/no longer exists/);
    expect(model).not.toHaveBeenCalled();
  });

  it("refuses a slot belonging to another client, before spending anything", async () => {
    const { sb } = database({ slot: { ...SLOT, client_id: "someone-else" } });
    const result = await runIdeationJob(sb, config, agent, engineJob, Date.now() + 60_000);
    expect(result.ok).toBe(false);
    expect(result.failureMessage).toMatch(/different client/);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("ideation when a person asked for it", () => {
  it("keeps a requested video reel and destination on every idea", async () => {
    modelReturns(25, "reel", "video");
    const directed = { ...handJob, params: {
      target_platform: "instagram", media_type: "video", content_format: "reel",
    } } as AgentJobRow;
    const { sb, inserted } = database();
    const result = await runIdeationJob(sb, config, agent, directed, Date.now() + 60_000);
    expect(result.ok).toBe(true);
    expect(inserted).toHaveLength(25);
    expect(inserted.every((row) => row.media_type === "video" && row.content_format === "reel"
      && row.target_platform === "instagram")).toBe(true);
    expect((model.mock.calls[0]![0] as { prompt: string }).prompt).toContain("Every idea is for instagram as video in reel format");
  });

  it("drops the model's wrong shape instead of silently making singles", async () => {
    modelReturns(25, "single", "image");
    const directed = { ...handJob, params: {
      target_platform: "instagram", media_type: "video", content_format: "reel",
    } } as AgentJobRow;
    const { sb, inserted } = database();
    const result = await runIdeationJob(sb, config, agent, directed, Date.now() + 60_000);
    expect(result.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("still fills a bank, at the unscoped count", async () => {
    modelReturns(25);
    const { sb, inserted } = database();
    await runIdeationJob(sb, config, agent, handJob, Date.now() + 60_000);
    const [{ prompt }] = model.mock.calls[0] as [{ prompt: string }];
    expect(prompt).toContain("idea bank of 25 ideas");
    expect(prompt).not.toMatch(/THE SLOT THIS IS FOR/);
    expect(inserted).toHaveLength(25);
  });

  it("keeps the model's own format, since nothing has decided one", async () => {
    modelReturns(25, "carousel");
    const { sb, inserted } = database();
    await runIdeationJob(sb, config, agent, handJob, Date.now() + 60_000);
    expect(inserted.every((row) => row.content_format === "carousel")).toBe(true);
    expect(inserted.every((row) => row.slot_id === null)).toBe(true);
  });
});
