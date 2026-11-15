import type { SupabaseClient } from "@supabase/supabase-js";
import { PlacementTransportError, patchLocationField } from "../proof-distribution/google-business.js";

interface ProfileClaim {
  attempt_id: string;
  claim_key: string;
  change_id: string;
  client_id: string;
  location_ref: string;
  field: string;
  before_value: string | null;
  proposed_value: string;
}

export type ProfileWriteResult =
  | { status: "held"; reason: string }
  | { status: "confirmed"; attemptId: string; providerRef: string }
  | { status: "refused" | "uncertain"; attemptId: string; reason: string };

function validClaim(value: unknown): value is ProfileClaim {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "claim_key", "change_id", "client_id", "location_ref",
    "field", "proposed_value"].every((key) =>
    typeof row[key] === "string" && String(row[key]).length > 0)
    && (row.before_value === null || typeof row.before_value === "string");
}

async function currentToken(sb: SupabaseClient, clientId: string): Promise<string | null> {
  const { data, error } = await sb.rpc("integration_secret", {
    p_client_id: clientId, p_provider: "google_business",
  });
  if (error) throw new Error(`Could not read the Google Business credential: ${error.message}`);
  return typeof data === "string" && data ? data : null;
}

/** One explicit profile proposal; not connected to the held scheduler. */
export async function writeApprovedGoogleProfileField(
  sb: SupabaseClient, changeId: string, fetchImpl: typeof fetch = fetch,
): Promise<ProfileWriteResult> {
  const { data: source, error: sourceError } = await sb.from("google_profile_changes")
    .select("id,client_id").eq("id", changeId).maybeSingle();
  if (sourceError) throw new Error(`Could not load the Google profile proposal: ${sourceError.message}`);
  if (!source) return { status: "held", reason: "The Google profile proposal no longer exists." };
  const token = await currentToken(sb, String(source.client_id));
  if (!token) return { status: "held", reason: "No current Google Business credential is available." };

  const { data, error } = await sb.rpc("claim_google_profile_execution_v6", { p_change_id: changeId });
  if (error) throw new Error(`Could not reserve the Google profile change: ${error.message}`);
  if (data === null) return { status: "held",
    reason: "No current exact approval is available, or this proposal already has an attempt." };
  if (!validClaim(data)) throw new Error("The Google profile execution claim was malformed.");
  const claim = data;
  if (claim.change_id !== changeId || claim.client_id !== source.client_id) {
    throw new Error("The Google profile claim did not match its source client and proposal.");
  }

  let started = false;
  try {
    const { externalRef, readbackValue } = await patchLocationField({
      accessToken: token, accountRef: claim.location_ref, field: claim.field,
      currentValue: claim.before_value, value: claim.proposed_value, fetchImpl,
      assertPrewrite: async () => {
        if (await currentToken(sb, claim.client_id) !== token) {
          throw new PlacementTransportError("Google Business credential changed before PATCH.", false);
        }
        const { data: allowed, error: gateError } = await sb.rpc("begin_google_profile_write_v6", {
          p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
        });
        if (gateError || allowed !== true) {
          throw new PlacementTransportError("The exact profile decision or one-shot claim is no longer current.", false);
        }
        started = true;
      },
    });
    const { data: saved, error: saveError } = await sb.rpc("finish_google_profile_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: "confirmed", p_observed_value: readbackValue,
      p_provider_ref: externalRef, p_note: null,
    });
    if (saveError || saved !== true) {
      throw new Error("Google field readback succeeded, but its local outcome could not be recorded.");
    }
    return { status: "confirmed", attemptId: claim.attempt_id, providerRef: externalRef };
  } catch (cause) {
    const status = started ? "uncertain" : "refused";
    const reason = cause instanceof PlacementTransportError
      ? cause.message : "The Google profile writer failed; inspect the provider before another attempt.";
    const { data: saved, error: saveError } = await sb.rpc("finish_google_profile_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: status, p_observed_value: null, p_provider_ref: null,
      p_note: reason,
    });
    if (saveError || saved !== true) {
      throw new Error("The Google profile outcome could not be recorded; inspect the reserved attempt.");
    }
    return { status, attemptId: claim.attempt_id, reason };
  }
}
