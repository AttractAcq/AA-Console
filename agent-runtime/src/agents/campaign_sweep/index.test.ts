import { describe, expect, it, vi } from "vitest";
import { runCampaignSweepJob } from "./index.js";

vi.mock("../../queue.js", () => ({ appendEvent: vi.fn(async () => undefined) }));

describe("campaign sweep uses planned ideas", () => {
  it("binds exact saved idea IDs and composes only brief and creative steps", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const campaign = {
      id: "campaign-1", client_id: "client-1", name: "Campaign", acquisition_mode: "both",
      channels: ["instagram", "facebook"], content_count: 2,
      organic_content_count: 1, paid_content_count: 1,
      content_spec_id: "spec-1", content_spec_hash: "hash-1",
      content_ideas_generated_at: "2026-11-15T00:00:00Z",
    };
    const spec = { client_id: "client-1", campaign_id: "campaign-1", content_hash: "hash-1",
      pieces: [
        { route: "organic", platform: "instagram", media_type: "video", content_format: "reel" },
        { route: "paid", platform: "facebook", media_type: "image", content_format: "carousel" },
      ] };
    const sb = {
      from: (table: string) => ({ select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: table === "client_campaigns" ? campaign : spec, error: null }),
      }) }) }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "campaign_sweep_blocker_v6") return { data: null, error: null };
        if (name === "bind_campaign_planned_ideas_v7")
          return { data: ["idea-1", "idea-2"], error: null };
        if (name === "create_workflow_run") return { data: { id: "run-1" }, error: null };
        return { data: null, error: null };
      },
    } as unknown as Parameters<typeof runCampaignSweepJob>[0];
    const job = { id: "job-1", client_id: "client-1", input_table: "client_campaigns",
      input_id: "campaign-1" } as Parameters<typeof runCampaignSweepJob>[3];
    const result = await runCampaignSweepJob(sb, {} as Parameters<typeof runCampaignSweepJob>[1],
      {} as Parameters<typeof runCampaignSweepJob>[2],
      job, Date.now() + 60_000);
    expect(result).toMatchObject({ ok: true });
    const steps = calls.filter((call) => call.name === "add_workflow_agent_step");
    expect(steps.map((step) => step.args.p_step_key)).toEqual([
      "piece1_brief", "piece1_create", "piece1_motion", "piece1_edit",
      "piece2_brief", "piece2_create",
    ]);
    expect(steps[0]?.args).toMatchObject({ p_input_id: "idea-1", p_input_from_step_key: null });
    expect(steps[4]?.args).toMatchObject({ p_input_id: "idea-2", p_input_from_step_key: null });
    expect(calls.find((call) => call.name === "create_workflow_run")?.args.p_input_snapshot)
      .toMatchObject({ planned_idea_ids: ["idea-1", "idea-2"] });
    expect(calls.at(-1)).toMatchObject({ name: "seal_workflow_run", args: { p_run_id: "run-1" } });
  });
});
