import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleReplyTransportError, putApprovedReviewReply } from "./review-reply.js";

interface ReplyClaim {
  attempt_id: string;
  claim_key: string;
  reply_id: string;
  client_id: string;
  exact_body: string;
  body_hash: string;
  location_ref: string;
  review_ref: string;
}

export type ReplySendResult =
  | { status: "held"; reason: string }
  | { status: "confirmed"; attemptId: string; providerState: string | null }
  | { status: "refused" | "uncertain"; attemptId: string; reason: string };

async function currentToken(sb: SupabaseClient, clientId: string): Promise<string | null> {
  const { data, error } = await sb.rpc("integration_secret", {
    p_client_id: clientId, p_provider: "google_business",
  });
  if (error) throw new Error(`Could not check the Google Business credential: ${error.message}`);
  return typeof data === "string" && data.length > 0 ? data : null;
}

function claimShape(value: unknown): value is ReplyClaim {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "claim_key", "reply_id", "client_id", "exact_body",
    "body_hash", "location_ref", "review_ref"].every((key) =>
    typeof row[key] === "string" && String(row[key]).length > 0);
}

/** One explicit reply. The caller must be the service-role runtime. */
export async function sendApprovedGoogleReply(
  sb: SupabaseClient, replyId: string, fetchImpl: typeof fetch = fetch,
): Promise<ReplySendResult> {
  const { data: reply, error: replyError } = await sb.from("google_review_replies")
    .select("id,client_id").eq("id", replyId).maybeSingle();
  if (replyError) throw new Error(`Could not load the Google reply: ${replyError.message}`);
  if (!reply) return { status: "held", reason: "The Google reply no longer exists." };
  const token = await currentToken(sb, String(reply.client_id));
  if (!token) return { status: "held", reason: "No usable Google Business credential is available." };

  const { data, error } = await sb.rpc("claim_google_reply_execution_v6", { p_reply_id: replyId });
  if (error) throw new Error(`Could not reserve the Google reply: ${error.message}`);
  if (data === null) {
    return { status: "held", reason: "No current exact approval is available, or this reply already has an attempt." };
  }
  if (!claimShape(data)) throw new Error("The Google reply claim packet was malformed.");
  const claim = data;
  if (claim.reply_id !== replyId || claim.client_id !== reply.client_id) {
    throw new Error("The Google reply claim did not match its source client and reply.");
  }

  let started = false;
  try {
    const receipt = await putApprovedReviewReply({
      accessToken: token,
      locationRef: claim.location_ref,
      reviewRef: claim.review_ref,
      exactBody: claim.exact_body,
      fetchImpl,
      assertPrewrite: async () => {
        // A rotation or revocation between claim and write makes the token
        // in memory stale, even if Google might still accept it.
        if (await currentToken(sb, claim.client_id) !== token) {
          throw new GoogleReplyTransportError("Google Business credential changed before the reply write.");
        }
        const { data: allowed, error: gateError } = await sb.rpc("begin_google_reply_write_v6", {
          p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
        });
        if (gateError || allowed !== true) {
          throw new GoogleReplyTransportError("The exact reply approval or one-shot write claim is no longer current.");
        }
        started = true;
      },
    });
    if (receipt.bodySha256 !== claim.body_hash) {
      throw new GoogleReplyTransportError("Google readback hash did not match the approved reply.", true);
    }
    const { data: saved, error: saveError } = await sb.rpc("finish_google_reply_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: "confirmed", p_observed_body_hash: receipt.bodySha256,
      p_provider_update_time: receipt.providerUpdateTime,
      p_provider_state: receipt.providerState,
      p_note: receipt.alreadyPresent ? "Exact reply was already present on Google." : null,
    });
    if (saveError || saved !== true) {
      throw new Error("Google reply readback succeeded, but its local outcome could not be recorded.");
    }
    return { status: "confirmed", attemptId: claim.attempt_id, providerState: receipt.providerState };
  } catch (cause) {
    const status = started ? "uncertain" : "refused";
    const reason = cause instanceof GoogleReplyTransportError
      ? cause.message : "The Google reply sender failed; inspect the provider before another attempt.";
    const { data: saved, error: saveError } = await sb.rpc("finish_google_reply_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: status, p_observed_body_hash: null,
      p_provider_update_time: null, p_provider_state: null, p_note: reason,
    });
    if (saveError || saved !== true) {
      throw new Error("The Google reply outcome could not be recorded; inspect the reserved attempt.");
    }
    return { status, attemptId: claim.attempt_id, reason };
  }
}
