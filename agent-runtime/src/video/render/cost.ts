import type { SupabaseClient } from "@supabase/supabase-js";
import type { LambdaCostEstimate } from "./handoff.js";

/** The database owns idempotency and ties the estimate to the provider
 * handle. This is Remotion's AWS estimate, not a reconciled AWS invoice.
 */
export async function fileLambdaRenderCost(input: { sb: SupabaseClient;
  attemptId: string; jobId: string; estimate: LambdaCostEstimate }): Promise<string> {
  const result = await input.sb.rpc("record_video_project_render_cost_v1", {
    p_attempt_id: input.attemptId, p_job_id: input.jobId,
    p_billing_ms: input.estimate.billingMs,
    p_estimated_usd: input.estimate.estimatedUsd,
    p_currency: input.estimate.currency });
  if (result.error || typeof result.data !== "string") {
    throw new Error("Lambda billing estimate could not be filed; inspect the provider attempt.");
  }
  return result.data;
}
