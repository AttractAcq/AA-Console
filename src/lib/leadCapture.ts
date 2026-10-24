import { supabase } from "./supabase";
import type { Database } from "../types/database";

/**
 * Lead capture, from the browser's side.
 *
 * Deliberately its own module rather than part of Lead Magnet Studio. A
 * magnet opt-in, a campaign page form and a sales-agent handoff are three
 * doors into the same room: one intake, one consent record, one
 * deduplication rule. The magnet happened to be the first page that needed
 * it, which is not a reason for it to own it.
 */

export type CaptureEndpoint = Database["public"]["Tables"]["lead_capture_endpoints"]["Row"];
export type CaptureDue = Database["public"]["Views"]["lead_capture_due"]["Row"];
export type LeadSubmission = Database["public"]["Tables"]["lead_submissions"]["Row"];

export const CAPTURE_PURPOSES = [
  { value: "page_form", label: "Page form", hint: "A form on a campaign or offer page." },
  { value: "magnet_optin", label: "Magnet opt-in", hint: "Promises a file in return." },
  { value: "agent_handoff", label: "Sales agent handoff", hint: "A widget conversation that becomes a lead." },
] as const;

export async function fetchEndpoints(
  clientId: string,
): Promise<{ endpoints: CaptureEndpoint[]; due: Map<string, CaptureDue> }> {
  const [rows, blockers] = await Promise.all([
    supabase
      .from("lead_capture_endpoints")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
    supabase.from("lead_capture_due").select("*").eq("client_id", clientId),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  if (blockers.error) throw new Error(blockers.error.message);
  return {
    endpoints: rows.data ?? [],
    due: new Map((blockers.data ?? []).map((row) => [String(row.endpoint_id), row])),
  };
}

export async function fetchSubmissions(clientId: string): Promise<LeadSubmission[]> {
  const { data, error } = await supabase
    .from("lead_submissions")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Open a capture endpoint, and hand the token back exactly once.
 *
 * Only the hash is stored, so this is the only moment the token exists in a
 * readable form. Losing it means issuing a new endpoint rather than reading
 * the old one back.
 */
export async function createEndpoint(args: {
  clientId: string;
  purpose: "magnet_optin" | "page_form" | "agent_handoff";
  consentWording: string;
  campaignId?: string | null;
  pageId?: string | null;
  sourceChannel?: string | null;
  magnetVersionId?: string | null;
  days?: number;
}): Promise<{ endpointId: string; token: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data, error } = await supabase.rpc("create_lead_capture_endpoint_v6", {
    p_client_id: args.clientId,
    p_purpose: args.purpose,
    p_token_hash: hash,
    p_consent_wording: args.consentWording.trim(),
    ...(args.campaignId ? { p_campaign_id: args.campaignId } : {}),
    ...(args.pageId ? { p_page_id: args.pageId } : {}),
    ...(args.sourceChannel ? { p_source_channel: args.sourceChannel } : {}),
    ...(args.days ? { p_days: args.days } : {}),
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  if (!row?.id) throw new Error("The endpoint was not created.");

  if (args.magnetVersionId) {
    const bound = await supabase
      .from("lead_capture_endpoints")
      .update({ magnet_version_id: args.magnetVersionId })
      .eq("id", row.id);
    if (bound.error) throw new Error(bound.error.message);
  }
  return { endpointId: row.id, token };
}

export async function setEndpointEnabled(endpointId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_lead_capture_enabled_v6", {
    p_endpoint_id: endpointId,
    p_enabled: enabled,
  });
  if (error) throw new Error(error.message);
}


/** A lead as the capture surface reads it: who, from where, under what consent. */
export interface CapturedLead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string;
  source: string | null;
  source_channel: string | null;
  consent_given_at: string | null;
  consent_wording: string | null;
  source_client_campaign_id: string | null;
  source_page_id: string | null;
  source_click_id: string | null;
  source_utm: unknown;
  created_at: string;
}

/**
 * Leads that arrived from outside, newest first.
 *
 * Filtered on consent rather than on a source string, because consent is the
 * fact that distinguishes them: a lead an employee typed in from a phone call
 * has a source too, and never saw a form.
 */
export async function fetchCapturedLeads(clientId: string): Promise<CapturedLead[]> {
  const { data, error } = await supabase
    .from("client_leads")
    .select(
      "id, name, email, phone, stage, source, source_channel, consent_given_at, consent_wording, source_client_campaign_id, source_page_id, source_click_id, source_utm, created_at",
    )
    .eq("client_id", clientId)
    .not("consent_given_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as CapturedLead[];
}
