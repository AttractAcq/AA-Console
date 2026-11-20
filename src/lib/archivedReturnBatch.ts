import { supabase } from "./supabase";

export interface ArchivedReturnBatchPacket {
  archived_lead_id: string;
  archived_name: string | null;
  source_hash: string;
  source_count: number;
  dm_count: number;
  decision_state: "single_source" | "grouped_hold";
  blocker: string;
  sources: Array<{
    kind: "form" | "sales_agent";
    submission_id?: string;
    conversation_id?: string;
    submitted_name?: string | null;
    submitted_email?: string | null;
    submitted_phone?: string | null;
    current_name?: string | null;
    current_email?: string | null;
    current_phone?: string | null;
    current_outcome?: string | null;
    matched?: {
      contact_name?: string | null;
      contact_email?: string | null;
      contact_phone?: string | null;
      outcome?: string | null;
      transcript_sha256?: string | null;
    };
    consent_wording?: string | null;
    source_snapshot?: { purpose?: string; source_channel?: string | null } | null;
    route_package_id?: string | null;
    click_id?: string | null;
    source_hash?: string;
  }>;
  dms: Array<{ conversation_id: string; platform: string; last_inbound_at: string | null }>;
}

export async function fetchArchivedReturnBatchPacket(archivedLeadId: string): Promise<ArchivedReturnBatchPacket> {
  const { data, error } = await supabase.rpc("archived_return_batch_review_packet_v11", {
    p_archived_lead_id: archivedLeadId,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The related arrivals could not be loaded.");
  }
  const packet = data as unknown as ArchivedReturnBatchPacket;
  if (packet.archived_lead_id !== archivedLeadId || !Array.isArray(packet.sources)
    || !Array.isArray(packet.dms) || !["single_source", "grouped_hold"].includes(packet.decision_state)
    || packet.source_count !== packet.sources.length || packet.dm_count !== packet.dms.length
    || !/^[0-9a-f]{64}$/.test(packet.source_hash)
    || packet.sources.some((source) => !["form", "sales_agent"].includes(source.kind)
      || !/^[0-9a-f]{64}$/.test(source.source_hash ?? "")
      || !(source.kind === "form" ? source.submission_id : source.conversation_id))
    || (packet.decision_state === "grouped_hold") !== (packet.source_count + packet.dm_count > 1)) {
    throw new Error("The related arrivals are incomplete. Review remains held.");
  }
  return packet;
}

export async function resolveArchivedReturnBatch(args: {
  archivedLeadId: string;
  action: "recover" | "new_lead";
  sourceHash: string;
  reason: string;
  primaryKind: "form" | "sales_agent" | null;
  primaryId: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("resolve_archived_return_batch_v11", {
    p_archived_lead_id: args.archivedLeadId,
    p_action: args.action,
    p_expected_hash: args.sourceHash,
    p_reason: args.reason.trim(),
    ...(args.action === "new_lead" ? {
      p_primary_kind: args.primaryKind ?? undefined,
      p_primary_id: args.primaryId ?? undefined,
    } : {}),
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The grouped identity decision did not complete.");
  return data;
}
