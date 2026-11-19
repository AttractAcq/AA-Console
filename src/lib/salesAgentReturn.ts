import { supabase } from "./supabase";

export interface SalesAgentReturnPacket {
  source_hash: string;
  conversation_id: string;
  archived_lead_id: string;
  archived_name: string | null;
  archived_email: string | null;
  archived_phone: string | null;
  archived_source: string | null;
  archived_at: string;
  matched: {
    contact_name?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    outcome?: string | null;
    matched_at?: string;
  };
  current_name: string | null;
  current_email: string | null;
  current_phone: string | null;
  current_outcome: string | null;
}

export async function fetchSalesAgentReturnPacket(conversationId: string): Promise<SalesAgentReturnPacket> {
  const { data, error } = await supabase.rpc("sales_agent_return_review_packet_v11", {
    p_conversation_id: conversationId,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "object") throw new Error("The sales return review is unavailable.");
  return data as unknown as SalesAgentReturnPacket;
}

export async function resolveSalesAgentReturn(args: {
  conversationId: string;
  action: "recover" | "new_lead";
  sourceHash: string;
  reason: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("resolve_sales_agent_return_v11", {
    p_conversation_id: args.conversationId,
    p_action: args.action,
    p_expected_hash: args.sourceHash,
    p_reason: args.reason.trim(),
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The sales return decision did not complete.");
  return data;
}
