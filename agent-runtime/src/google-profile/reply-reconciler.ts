import type { SupabaseClient } from "@supabase/supabase-js";
import { readApprovedReviewReply } from "./review-reply.js";

interface Target {
  attempt_id: string;
  client_id: string;
  reply_id: string;
  location_ref: string;
  review_ref: string;
}

function validTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "client_id", "reply_id", "location_ref", "review_ref"]
    .every((key) => typeof row[key] === "string" && String(row[key]).length > 0);
}

async function currentToken(sb: SupabaseClient, clientId: string): Promise<string | null> {
  const { data: eligible, error: gateError } = await sb.rpc("google_reply_credential_eligible_v6", {
    p_client_id: clientId,
  });
  if (gateError) throw new Error("Could not check the current Google Business credential.");
  if (eligible !== true) return null;
  const { data, error } = await sb.rpc("integration_secret", {
    p_client_id: clientId, p_provider: "google_business",
  });
  if (error) throw new Error("Could not read the current Google Business credential.");
  return typeof data === "string" && data ? data : null;
}

/** Checks one uncertain PUT through provider GETs without repeating the write. */
export async function reconcileUncertainGoogleReply(
  sb: SupabaseClient, attemptId: string, clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "held" | "matched" | "pending" | "rejected" | "different" | "unverified";
  reason?: string }> {
  const { data, error } = await sb.rpc("google_reply_reconciliation_target_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
  });
  if (error) throw new Error("Could not load the uncertain Google reply attempt.");
  if (!validTarget(data) || data.attempt_id !== attemptId || data.client_id !== clientId) {
    return { status: "held", reason: "No current uncertain reply attempt belongs to this client." };
  }
  const token = await currentToken(sb, clientId);
  if (!token) return { status: "held", reason: "A current reviewed Google Business credential is required." };
  const observation = await readApprovedReviewReply({
    accessToken: token, locationRef: data.location_ref,
    reviewRef: data.review_ref, fetchImpl,
  });
  if (await currentToken(sb, clientId) !== token) {
    return { status: "held", reason: "The Google Business credential changed during reply readback." };
  }
  const { data: recorded, error: recordError } = await sb.rpc("record_google_reply_reconciliation_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
    p_review_ref: observation.reviewRef,
    p_observed_body_hash: observation.bodySha256,
    p_provider_update_time: observation.providerUpdateTime,
    p_provider_state: observation.providerState,
  });
  if (recordError || !["matched", "pending", "rejected", "different", "unverified"].includes(String(recorded))) {
    throw new Error("The read-only Google reply observation could not be recorded.");
  }
  return { status: recorded as "matched" | "pending" | "rejected" | "different" | "unverified" };
}
