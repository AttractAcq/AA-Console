import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  advanceSlot,
  failSlot,
  handOffToSlot,
  isEngineJob,
  loadSlot,
  slotIdOf,
  SLOT_IDEA_COUNT,
} from "./slot.js";
import type { AgentJobRow } from "../queue.js";

const job = (params: unknown, clientId: string | null = "c1"): AgentJobRow =>
  ({ id: "j1", client_id: clientId, params, input_table: "content_slots", input_id: "s1" }) as unknown as AgentJobRow;

function sbReturning(row: unknown, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error });
  return {
    client: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
      rpc: vi.fn().mockResolvedValue({ error: null }),
    },
    maybeSingle,
  };
}

const SLOT = {
  id: "s1",
  client_id: "c1",
  stage: "ideating",
  format: "reel",
  platform: "instagram",
  scheduled_at: "2026-11-02T09:00:00Z",
  pillar_id: "p1",
  idea_id: null,
  brief_id: null,
  asset_id: null,
  attempts: 0,
};

describe("reading the slot off a job", () => {
  it("finds the id the engine put in params", () => {
    expect(slotIdOf(job({ slot_id: "s1", source: "engine" }))).toBe("s1");
    expect(isEngineJob(job({ slot_id: "s1" }))).toBe(true);
  });

  it("says there is no slot when a person ran the agent", () => {
    // The same agents still work when somebody presses the button, so no
    // slot is an ordinary case rather than a fault.
    expect(slotIdOf(job({}))).toBeNull();
    expect(slotIdOf(job(null))).toBeNull();
    expect(isEngineJob(job({}))).toBe(false);
  });

  it("ignores a slot_id that is not a usable id", () => {
    expect(slotIdOf(job({ slot_id: "" }))).toBeNull();
    expect(slotIdOf(job({ slot_id: 42 }))).toBeNull();
    expect(slotIdOf(job({ slot_id: null }))).toBeNull();
  });
});

describe("loadSlot", () => {
  it("returns null for a job with no slot, without asking the database", async () => {
    const { client, maybeSingle } = sbReturning(SLOT);
    expect(await loadSlot(client as never, job({}))).toBeNull();
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("returns the slot for a job that has one", async () => {
    const { client } = sbReturning(SLOT);
    expect(await loadSlot(client as never, job({ slot_id: "s1" }))).toMatchObject({
      id: "s1",
      format: "reel",
      pillar_id: "p1",
    });
  });

  it("throws when the job names a slot that is gone", async () => {
    // Carrying on without the constraints the slot carries would produce
    // work nobody asked for and file it as though they had.
    const { client } = sbReturning(null);
    await expect(loadSlot(client as never, job({ slot_id: "s1" }))).rejects.toThrow(/no longer exists/);
  });

  it("throws when the slot belongs to another client", async () => {
    const { client } = sbReturning({ ...SLOT, client_id: "somebody-else" });
    await expect(loadSlot(client as never, job({ slot_id: "s1" }))).rejects.toThrow(/different client/);
  });

  it("surfaces a read error rather than treating it as no slot", async () => {
    const { client } = sbReturning(null, { message: "connection reset" });
    await expect(loadSlot(client as never, job({ slot_id: "s1" }))).rejects.toThrow(/connection reset/);
  });
});

describe("advanceSlot", () => {
  it("goes through the RPC, never a direct write", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await advanceSlot({ rpc } as never, "s1", "idea_selected", {
      agentKey: "ideation",
      costUsd: 0.2,
      ideaId: "i1",
    });
    expect(rpc).toHaveBeenCalledWith(
      "advance_slot",
      expect.objectContaining({
        p_slot_id: "s1",
        p_to_stage: "idea_selected",
        p_actor: "agent",
        p_agent_key: "ideation",
        p_cost_usd: 0.2,
        p_idea_id: "i1",
      }),
    );
  });

  it("raises when the move was refused, since the caller must not carry on", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "A slot cannot go from planned to published." } });
    await expect(advanceSlot({ rpc } as never, "s1", "published")).rejects.toThrow(/cannot go from planned/);
  });
});

describe("failSlot", () => {
  it("records the reason in both the note and blocked_reason", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await failSlot({ rpc } as never, "s1", "Higgsfield returned nothing", { agentKey: "video_build" });
    expect(rpc).toHaveBeenCalledWith(
      "advance_slot",
      expect.objectContaining({
        p_to_stage: "failed",
        p_note: "Higgsfield returned nothing",
        p_blocked_reason: "Higgsfield returned nothing",
      }),
    );
  });

  it("stays quiet when it cannot report, so the real failure survives", async () => {
    // An agent that throws while reporting a failure replaces a message
    // about what went wrong with a message about the reporting.
    const rpc = vi.fn().mockResolvedValue({ error: { message: "already failed" } });
    await expect(failSlot({ rpc } as never, "s1", "the real problem")).resolves.toBeUndefined();
  });
});

describe("how many ideas a slot asks for", () => {
  it("is a handful, not a bank", () => {
    // Twenty-five ideas for one post is twenty-one nobody reads and a bill
    // for all of them.
    expect(SLOT_IDEA_COUNT).toBeGreaterThanOrEqual(3);
    expect(SLOT_IDEA_COUNT).toBeLessThanOrEqual(5);
  });
});

describe("handOffToSlot", () => {
  function sb(asset: { id: string } | null) {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: asset, error: null });
    const client = {
      rpc,
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle }) }) }) }),
      }),
    };
    return { client, rpc, maybeSingle };
  }

  const buildJob = (params: unknown) =>
    ({ id: "j1", client_id: "c1", params, input_table: "client_briefs", input_id: "brief-1" }) as unknown as AgentJobRow;

  it("finds the asset by the brief the job was pointed at, and moves the slot", async () => {
    const { client, rpc } = sb({ id: "asset-1" });
    await handOffToSlot(client as never, buildJob({ slot_id: "s1" }), "creative_build");
    expect(rpc).toHaveBeenCalledWith(
      "advance_slot",
      expect.objectContaining({
        p_slot_id: "s1",
        p_to_stage: "copywriting",
        p_asset_id: "asset-1",
        p_agent_key: "creative_build",
      }),
    );
  });

  it("does nothing for a hand run, which has no slot", async () => {
    const { client, rpc, maybeSingle } = sb({ id: "asset-1" });
    await handOffToSlot(client as never, buildJob({}), "creative_build");
    expect(rpc).not.toHaveBeenCalled();
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("leaves the slot where it is when the build produced no asset", async () => {
    // Moving it on to be written about would mean writing copy about
    // nothing. Staying put keeps the failure visible on the board.
    const { client, rpc } = sb(null);
    await handOffToSlot(client as never, buildJob({ slot_id: "s1" }), "creative_build");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends a reel to editing, because clips are not a video", async () => {
    // The gap this closes. video_build makes stills and submits the
    // Higgsfield clips; it produces nothing watchable. Handing off to
    // copywriting is what let an uncut reel reach a person — QA reads
    // dimensions only video_edit writes and treats a null as nothing to
    // check, so it scored 100 on the way past.
    const { client, rpc } = sb({ id: "asset-1" });
    await handOffToSlot(client as never, buildJob({ slot_id: "s1" }), "video_build", "editing");
    expect(rpc).toHaveBeenCalledWith(
      "advance_slot",
      expect.objectContaining({
        p_slot_id: "s1",
        p_to_stage: "editing",
        p_asset_id: "asset-1",
        p_agent_key: "video_build",
      }),
    );
  });

  it("still defaults to copywriting, so every other build is unchanged", async () => {
    const { client, rpc } = sb({ id: "asset-1" });
    await handOffToSlot(client as never, buildJob({ slot_id: "s1" }), "creative_build");
    const args = rpc.mock.calls[0]![1] as { p_to_stage: string };
    expect(args.p_to_stage).toBe("copywriting");
  });

  it("is called with 'editing' by video_build and nothing else", () => {
    /**
     * A call-site test, because the unit tests above pass the stage in
     * themselves and so cannot catch the caller passing the wrong one — which
     * is the regression that matters. video_build makes footage; only
     * video_edit makes a video.
     */
    const callers = {
      "../agents/video_build/index.ts": "editing",
      "../agents/creative_build/index.ts": null,
    } as const;

    for (const [path, stage] of Object.entries(callers)) {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      const call = src.match(/handOffToSlot\((?:[^;]*?)\);/s);
      expect(call, `${path} no longer calls handOffToSlot`).not.toBeNull();
      if (stage === null) {
        // No fourth argument: the default is copywriting, which is right for
        // a build that produced the finished thing.
        expect(call![0], path).not.toMatch(/"editing"/);
      } else {
        expect(call![0], path).toContain(`"${stage}"`);
      }
    }
  });

  it("says which hand-off it was in the note", async () => {
    // "Asset built." is wrong for a reel that has no asset yet, and the note
    // is what a person reads on the slot timeline.
    const reel = sb({ id: "asset-1" });
    await handOffToSlot(reel.client as never, buildJob({ slot_id: "s1" }), "video_build", "editing");
    expect((reel.rpc.mock.calls[0]![1] as { p_note: string }).p_note).toMatch(/cut comes next/i);

    const still = sb({ id: "asset-1" });
    await handOffToSlot(still.client as never, buildJob({ slot_id: "s1" }), "creative_build");
    expect((still.rpc.mock.calls[0]![1] as { p_note: string }).p_note).toBe("Asset built.");
  });
});
