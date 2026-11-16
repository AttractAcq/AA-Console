import type { SupabaseClient } from "@supabase/supabase-js";
import { readMetaPageField } from "./meta-page.js";

interface Target {
  attempt_id: string;
  client_id: string;
  change_id: string;
  page_id: string;
  field: "about" | "website_url";
  proposed_value: string;
}

function validTarget(value: unknown): value is Target {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "client_id", "change_id", "page_id", "proposed_value"]
    .every((key) => typeof row[key] === "string" && String(row[key]).length > 0)
    && (row.field === "about" || row.field === "website_url");
}

async function currentToken(sb: SupabaseClient, clientId: string): Promise<string | null> {
  const { data: eligible, error: gateError } = await sb.rpc("meta_profile_write_credential_eligible_v6", {
    p_client_id: clientId,
  });
  if (gateError) throw new Error("Could not check the current Meta Page credential.");
  if (eligible !== true) return null;
  const { data, error } = await sb.rpc("integration_secret", {
    p_client_id: clientId, p_provider: "meta",
  });
  if (error) throw new Error("Could not read the current Meta Page credential.");
  return typeof data === "string" && data ? data : null;
}

/** Read the provider once; never repeats the uncertain write. */
export async function reconcileUncertainMetaPageField(
  sb: SupabaseClient, attemptId: string, clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "held" | "matched" | "different"; reason?: string }> {
  const { data, error } = await sb.rpc("meta_profile_reconciliation_target_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
  });
  if (error) throw new Error("Could not load the uncertain Meta Page attempt.");
  if (!validTarget(data) || data.attempt_id !== attemptId || data.client_id !== clientId) {
    return { status: "held", reason: "No current uncertain Page attempt belongs to this client." };
  }
  const token = await currentToken(sb, clientId);
  if (!token) return { status: "held", reason: "A current reviewed Page credential is required." };
  const observation = await readMetaPageField({
    accessToken: token, pageId: data.page_id, field: data.field, fetchImpl,
  });
  if (await currentToken(sb, clientId) !== token) {
    return { status: "held", reason: "The Page credential changed during reconciliation." };
  }
  const { data: recorded, error: recordError } = await sb.rpc("record_meta_profile_reconciliation_v6", {
    p_attempt_id: attemptId, p_client_id: clientId,
    p_observed_value: observation.observedValue, p_provider_ref: observation.providerRef,
  });
  if (recordError || (recorded !== "matched" && recorded !== "different")) {
    throw new Error("The read-only Meta Page observation could not be recorded.");
  }
  return { status: recorded };
}
