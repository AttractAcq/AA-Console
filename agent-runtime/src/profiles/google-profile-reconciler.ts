import type { SupabaseClient } from "@supabase/supabase-js";
import { readVerifiedLocationField } from "../proof-distribution/google-business.js";

interface Target {
  attempt_id: string;
  client_id: string;
  change_id: string;
  location_ref: string;
  field: string;
  proposed_value: string;
}

function validTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "client_id", "change_id", "location_ref", "field", "proposed_value"]
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

/** Read the merchant record once; never repeats an uncertain PATCH. */
export async function reconcileUncertainGoogleProfileField(
  sb: SupabaseClient, attemptId: string, clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "held" | "matched" | "different"; reason?: string }> {
  const { data, error } = await sb.rpc("google_profile_reconciliation_target_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
  });
  if (error) throw new Error("Could not load the uncertain Google location attempt.");
  if (!validTarget(data) || data.attempt_id !== attemptId || data.client_id !== clientId) {
    return { status: "held", reason: "No current uncertain location attempt belongs to this client." };
  }
  const token = await currentToken(sb, clientId);
  if (!token) return { status: "held", reason: "A current reviewed Google Business credential is required." };
  const observation = await readVerifiedLocationField({
    accessToken: token, accountRef: data.location_ref, field: data.field, fetchImpl,
  });
  if (await currentToken(sb, clientId) !== token) {
    return { status: "held", reason: "The Google Business credential changed during reconciliation." };
  }
  const { data: recorded, error: recordError } = await sb.rpc("record_google_profile_reconciliation_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
    p_observed_value: observation.observedValue, p_provider_ref: observation.externalRef,
  });
  if (recordError || (recorded !== "matched" && recorded !== "different")) {
    throw new Error("The read-only Google location observation could not be recorded.");
  }
  return { status: recorded };
}
