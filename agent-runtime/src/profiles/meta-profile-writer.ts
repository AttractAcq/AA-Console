import type { SupabaseClient } from "@supabase/supabase-js";
import { MetaProfileTransportError, updateMetaPageField } from "./meta-page.js";

interface MetaClaim {
  attempt_id: string;
  claim_key: string;
  change_id: string;
  client_id: string;
  page_id: string;
  field: string;
  before_value: string | null;
  proposed_value: string;
}

export type MetaProfileWriteResult =
  | { status: "held"; reason: string }
  | { status: "confirmed"; attemptId: string; providerRef: string }
  | { status: "refused" | "uncertain"; attemptId: string; reason: string };

function validClaim(value: unknown): value is MetaClaim {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["attempt_id", "claim_key", "change_id", "client_id", "page_id",
    "field", "proposed_value"].every((key) =>
    typeof row[key] === "string" && String(row[key]).length > 0)
    && (row.before_value === null || typeof row.before_value === "string");
}

async function currentToken(sb: SupabaseClient, clientId: string): Promise<string | null> {
  const { data: eligible, error: gateError } = await sb.rpc("meta_profile_write_credential_eligible_v6", {
    p_client_id: clientId,
  });
  if (gateError) throw new Error(`Could not check the Meta Page write grant: ${gateError.message}`);
  if (eligible !== true) return null;
  const { data, error } = await sb.rpc("integration_secret", {
    p_client_id: clientId, p_provider: "meta",
  });
  if (error) throw new Error(`Could not read the Meta Page credential: ${error.message}`);
  return typeof data === "string" && data ? data : null;
}

/** One exact Facebook Page proposal, not connected to a scheduled worker. */
export async function writeApprovedMetaPageField(
  sb: SupabaseClient, changeId: string, expectedClientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaProfileWriteResult> {
  const { data: source, error: sourceError } = await sb.from("meta_profile_changes")
    .select("id,client_id").eq("id", changeId).maybeSingle();
  if (sourceError) throw new Error(`Could not load the Meta profile proposal: ${sourceError.message}`);
  if (!source) return { status: "held", reason: "The Meta profile proposal no longer exists." };
  if (source.client_id !== expectedClientId) return { status: "held",
    reason: "The queued client does not own this Meta profile proposal." };
  const token = await currentToken(sb, expectedClientId);
  if (!token) return { status: "held",
    reason: "A current, AAL2-reviewed Meta Page write credential is required." };

  const { data, error } = await sb.rpc("claim_meta_profile_execution_v6", { p_change_id: changeId });
  if (error) throw new Error(`Could not reserve the Meta profile change: ${error.message}`);
  if (data === null) return { status: "held",
    reason: "No current exact approval is available, or this proposal already has an attempt." };
  if (!validClaim(data)) throw new Error("The Meta profile execution claim was malformed.");
  const claim = data;
  if (claim.change_id !== changeId || claim.client_id !== expectedClientId) {
    throw new Error("The Meta profile claim did not match its source client and proposal.");
  }

  let started = false;
  try {
    const { providerRef, readbackValue } = await updateMetaPageField({
      accessToken: token, pageId: claim.page_id, field: claim.field,
      currentValue: claim.before_value, value: claim.proposed_value, fetchImpl,
      assertPrewrite: async () => {
        if (await currentToken(sb, claim.client_id) !== token) {
          throw new MetaProfileTransportError("Meta Page credential changed before POST.");
        }
        const { data: allowed, error: gateError } = await sb.rpc("begin_meta_profile_write_v6", {
          p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
        });
        if (gateError || allowed !== true) {
          throw new MetaProfileTransportError("The exact Meta profile decision or one-shot claim is no longer current.");
        }
        started = true;
      },
    });
    const { data: saved, error: saveError } = await sb.rpc("finish_meta_profile_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: "confirmed", p_observed_value: readbackValue,
      p_provider_ref: providerRef, p_note: null,
    });
    if (saveError || saved !== true) {
      throw new Error("Meta Page readback succeeded, but its local outcome could not be recorded.");
    }
    return { status: "confirmed", attemptId: claim.attempt_id, providerRef };
  } catch (cause) {
    const status = started ? "uncertain" : "refused";
    const reason = cause instanceof MetaProfileTransportError
      ? cause.message : "The Meta Page writer failed; inspect the provider before another attempt.";
    const { data: saved, error: saveError } = await sb.rpc("finish_meta_profile_execution_v6", {
      p_attempt_id: claim.attempt_id, p_claim_key: claim.claim_key,
      p_outcome: status, p_observed_value: null, p_provider_ref: null,
      p_note: reason,
    });
    if (saveError || saved !== true) {
      throw new Error("The Meta profile outcome could not be recorded; inspect the reserved attempt.");
    }
    return { status, attemptId: claim.attempt_id, reason };
  }
}
