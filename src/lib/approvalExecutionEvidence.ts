import { supabase } from "./supabase";

export type ApprovalExecutionIdentity = {
  id: string;
  client_id: string | null;
  source_kind: string;
  source_id: string;
  status: string;
};

export type ApprovalExecutionEvidence = {
  state: string;
  detail: string;
  externalRef: string | null;
};

const JOINED_KINDS = new Set([
  "campaign_action", "google_review_reply", "google_profile_change", "meta_profile_change",
  "proof_placement", "proof_delivery", "lead_magnet",
]);
const VISIBLE_OUTCOME_STATES = new Set(["approved", "revoked", "source_decided", "stale", "superseded"]);

export function hasJoinedExecutionEvidence(sourceKind: string): boolean {
  return JOINED_KINDS.has(sourceKind);
}

export function shouldShowExecutionEvidence(request: ApprovalExecutionIdentity): boolean {
  return VISIBLE_OUTCOME_STATES.has(request.status) && !!request.client_id
    && hasJoinedExecutionEvidence(request.source_kind);
}

/** Read execution ledgers separately from the human decision. A failed ledger read stays unknown. */
export async function loadApprovalExecutionEvidence(
  requests: ApprovalExecutionIdentity[],
): Promise<Map<string, ApprovalExecutionEvidence>> {
  const result = new Map<string, ApprovalExecutionEvidence>();
  const eligible = requests.filter(shouldShowExecutionEvidence);
  const groups = new Map<string, { kind: string; clientId: string;
    rows: ApprovalExecutionIdentity[] }>();
  for (const request of eligible) {
    const clientId = request.client_id!;
    const groupKey = `${request.source_kind}:${clientId}`;
    const group = groups.get(groupKey) ?? { kind: request.source_kind,
      clientId, rows: [] };
    group.rows.push(request);
    groups.set(groupKey, group);
  }

  await Promise.all([...groups.values()].map(async ({ kind, clientId, rows }) => {
    const key = kind === "campaign_action" ? "source_id" : "id";
    const ids = rows.map((row) => row[key]);
    const byId = new Map(rows.map((row) => [row[key], row]));
    try {
      if (kind === "proof_placement" || kind === "proof_delivery" || kind === "lead_magnet") {
        const { data, error } = kind === "lead_magnet"
          ? await supabase.from("lead_magnet_approval_execution_evidence_v6")
            .select("request_id,client_id,source_kind,state,detail,external_ref")
            .in("request_id", ids)
          : await supabase.from("proof_approval_execution_evidence_v6")
            .select("request_id,client_id,source_kind,state,detail,external_ref")
            .in("request_id", ids);
        if (error) throw error;
        for (const item of data ?? []) {
          const request = item.request_id ? byId.get(item.request_id) : null;
          if (!request || item.client_id !== request.client_id || item.source_kind !== kind) continue;
          result.set(request.id, {
            state: item.state ?? "unknown",
            detail: item.detail ?? "No external effect is proved.",
            externalRef: item.external_ref,
          });
        }
      } else if (kind === "campaign_action") {
        const { data, error } = await supabase.from("campaign_action_due")
          .select("approval_id,client_id,execution_status,blocker,external_id,external_url")
          .in("approval_id", ids);
        if (error) throw error;
        for (const item of data ?? []) {
          const request = item.approval_id ? byId.get(item.approval_id) : null;
          if (!request || item.client_id !== request.client_id) continue;
          result.set(request.id, {
            state: item.execution_status ?? (item.blocker ? "held" : "not attempted"),
            detail: item.blocker ?? (item.execution_status === "executed"
              ? "A local execution is recorded; inspect the owner for the external effect."
              : "No completed execution is recorded."),
            externalRef: item.external_url ?? item.external_id,
          });
        }
      } else if (kind === "google_review_reply") {
        const { data, error } = await supabase.rpc(
          "list_google_reply_execution_overview_v6", { p_client_id: clientId })
          .select("approval_request_id,client_id,status,reconciliation_result,provider_state")
          .in("approval_request_id", ids);
        if (error) throw error;
        for (const item of data ?? []) {
          const request = item.approval_request_id ? byId.get(item.approval_request_id) : null;
          if (!request || item.client_id !== request.client_id) continue;
          result.set(request.id, {
            state: item.status ?? "unknown",
            detail: item.reconciliation_result
              ? `Readback: ${item.reconciliation_result}. Original attempt remains ${item.status ?? "unknown"}.`
              : `Provider moderation state: ${item.provider_state ?? "not observed"}.`,
            externalRef: null,
          });
        }
      } else {
        const fn = kind === "google_profile_change"
          ? "list_google_profile_execution_overview_v6" as const
          : "list_meta_profile_execution_overview_v6" as const;
        const { data, error } = await supabase.rpc(fn, { p_client_id: clientId })
          .select("approval_request_id,client_id,status,reconciliation_result,provider_ref")
          .in("approval_request_id", ids);
        if (error) throw error;
        for (const item of data ?? []) {
          const request = item.approval_request_id ? byId.get(item.approval_request_id) : null;
          if (!request || item.client_id !== request.client_id) continue;
          result.set(request.id, {
            state: item.status ?? "unknown",
            detail: item.reconciliation_result
              ? `Readback: ${item.reconciliation_result}. Original attempt remains ${item.status ?? "unknown"}.`
              : "See the owning profile for provider preflight and readback.",
            externalRef: item.provider_ref,
          });
        }
      }
    } catch {
      for (const request of rows) result.set(request.id, {
        state: "unknown", detail: "Execution ledger could not be read. Check the owning source.",
        externalRef: null,
      });
    }
    for (const request of rows) if (!result.has(request.id)) result.set(request.id, {
      state: "unknown", detail: "No same-client execution row was observed in this ledger.",
      externalRef: null,
    });
  }));
  return result;
}
