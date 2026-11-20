import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fileLambdaRenderCost } from "./cost.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

describe("Lambda estimate receipt", () => {
  it("files the provider estimate under the exact attempt and job", async () => {
    const rpc = vi.fn(async () => ({ data:
      "33333333-3333-4333-8333-333333333333", error: null }));
    const sb = { rpc } as unknown as SupabaseClient;
    await expect(fileLambdaRenderCost({ sb, attemptId, jobId,
      estimate: { billingMs: 42000, estimatedUsd: 0.036,
        currency: "USD" } })).resolves.toBe(
      "33333333-3333-4333-8333-333333333333");
    expect(rpc).toHaveBeenCalledWith("record_video_project_render_cost_v1", {
      p_attempt_id: attemptId, p_job_id: jobId,
      p_billing_ms: 42000, p_estimated_usd: 0.036,
      p_currency: "USD" });
  });

  it("holds the candidate when the database refuses its cost", async () => {
    const sb = { rpc: async () => ({ data: null,
      error: { message: "receipt unavailable" } }) } as unknown as SupabaseClient;
    await expect(fileLambdaRenderCost({ sb, attemptId, jobId,
      estimate: { billingMs: 42000, estimatedUsd: 0.036,
        currency: "USD" } })).rejects.toThrow("could not be filed");
  });
});
