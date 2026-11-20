import { describe, expect, it, vi } from "vitest";
import { runGoogleSearchCopyJob } from "./index.js";

vi.mock("../../config.js", () => ({ anthropicKeyForAgent: () => "fixture-key" }));
vi.mock("../../queue.js", () => ({ appendEvent: vi.fn(async () => undefined) }));
vi.mock("../../tools/anthropic.js", () => ({
  ProviderError: class ProviderError extends Error {},
  runAgentLoop: vi.fn(async () => ({ submitted: {
    headlines: ["Book a Home Survey", "Explore Your Options", "Speak With Our Team"],
    descriptions: ["Discuss your project with our local team.",
      "Book a consultation to explore the next step."],
    rationale: "The copy invites the target buyer to discuss the signed offer.",
  }, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } })),
}));

describe("Google search-copy producer", () => {
  const job = { id: "job-1", agent_key: "google_search_copy", client_id: "client-1",
    input_table: "client_ideas", status: "running", attempts: 1, max_attempts: 3,
    lease_owner: null, lease_until: null,
    input_id: "idea-1", params: { v5_workflow_run_id: "run-1",
      v5_step_key: "piece2_create", piece_index: 2 } } as Parameters<typeof runGoogleSearchCopyJob>[3];

  it("records bounded copy from the exact paid-route work item without an ad action", async () => {
    const reads: Record<string, unknown> = {
      workflow_steps: { id: "step-1", run_id: "run-1", step_key: "piece2_create",
        input_params: { piece_index: 2 } },
      campaign_sweep_work_bindings_v7: { work_item_id: "work-1", final_step_key: "piece2_create" },
      delivery_work_items_v6: { id: "work-1", client_id: "client-1", campaign_id: "camp-1",
        route_key: "paid", input_snapshot: { planned_idea_id: "idea-1", piece_index: 2 },
        expected_output: { platform: "google_ads" } },
      client_ideas: { id: "idea-1", client_id: "client-1", campaign_id: "camp-1",
        campaign_position: 2, title: "Local consultation", body: "Discuss a service need" },
      workflow_runs: { id: "run-1", client_id: "client-1", campaign_id: "camp-1",
        kind: "campaign_sweep" },
      campaign_google_search_copy_versions_v7: null,
      client_campaigns: { id: "camp-1", offer_version_id: "offer-1",
        name: "Campaign", objective: "Consultations" },
      service_offer_versions: { audience: "Local buyers", promise: "Consultation",
        inclusions: [], exclusions: [], claims: [] },
    };
    const rpcCalls: string[] = [];
    const sb = {
      from: (table: string) => {
        const query = { select: () => query, eq: () => query,
          maybeSingle: async () => ({ data: reads[table] ?? null, error: null }) };
        return query;
      },
      rpc: async (name: string) => { rpcCalls.push(name); return { data: null, error: null }; },
    } as unknown as Parameters<typeof runGoogleSearchCopyJob>[0];
    const result = await runGoogleSearchCopyJob(sb,
      { model: "fixture", providerTimeoutMs: 1000 } as Parameters<typeof runGoogleSearchCopyJob>[1],
      { agent_key: "google_search_copy" } as Parameters<typeof runGoogleSearchCopyJob>[2],
      job, Date.now() + 60_000);
    expect(result).toMatchObject({ ok: true, usage: { costUsd: 0.01 } });
    expect(rpcCalls).toEqual(["campaign_sweep_blocker_v6", "record_campaign_google_search_copy_v7"]);
  });

  it("refuses a job without a workflow identity", async () => {
    const result = await runGoogleSearchCopyJob({} as Parameters<typeof runGoogleSearchCopyJob>[0],
      {} as Parameters<typeof runGoogleSearchCopyJob>[1],
      {} as Parameters<typeof runGoogleSearchCopyJob>[2],
      { ...job, params: null }, Date.now() + 60_000);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
