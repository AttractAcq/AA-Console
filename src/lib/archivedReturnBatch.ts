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
    || !Array.isArray(packet.dms) || !["single_source", "grouped_hold"].includes(packet.decision_state)) {
    throw new Error("The related arrivals are incomplete. Review remains held.");
  }
  return packet;
}
