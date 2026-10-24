import { supabase } from "./supabase";
import { uploadThen } from "./options";
import type { Database } from "../types/database";

/**
 * Lead Magnet Studio, from the browser's side.
 *
 * The shape to keep in mind is that a magnet, a version of it and a delivery
 * are three different things. The magnet is what the client offers; the
 * version is the actual bytes plus the words that carry them; a delivery is
 * one send to one person who opted in. An approval is given against a
 * version, never against a magnet and never against a send — so re-exporting
 * the file produces a new version that nobody has approved yet, rather than
 * quietly changing what forty people are about to receive.
 */

export type LeadMagnet = Database["public"]["Tables"]["lead_magnets"]["Row"];
export type LeadMagnetVersion = Database["public"]["Tables"]["lead_magnet_versions"]["Row"];
export type LeadMagnetApproval = Database["public"]["Tables"]["lead_magnet_approvals"]["Row"];
export type LeadMagnetDue = Database["public"]["Views"]["lead_magnet_due"]["Row"];
export type CaptureEndpoint = Database["public"]["Tables"]["lead_capture_endpoints"]["Row"];
export type CaptureDue = Database["public"]["Views"]["lead_capture_due"]["Row"];
export type LeadSubmission = Database["public"]["Tables"]["lead_submissions"]["Row"];

export const MAGNET_FORMATS = [
  { value: "pdf_guide", label: "PDF guide" },
  { value: "checklist", label: "Checklist" },
  { value: "template", label: "Template" },
  { value: "video", label: "Video" },
  { value: "email_course", label: "Email course" },
] as const;

/** What each delivery channel actually commits the client to. */
export const CHANNEL_HINT: Record<string, string> = {
  email: "The file is attached and emailed to the address they opted in with.",
  download_link: "The page hands it over at opt-in. Nothing is sent afterwards.",
};

const MAGNET_BUCKET = "client-media";

export async function fetchMagnets(clientId: string): Promise<LeadMagnet[]> {
  const { data, error } = await supabase
    .from("lead_magnets")
    .select("*")
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchVersions(clientId: string): Promise<LeadMagnetVersion[]> {
  const { data, error } = await supabase
    .from("lead_magnet_versions")
    .select("*")
    .eq("client_id", clientId)
    .order("version", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchApprovals(clientId: string): Promise<LeadMagnetApproval[]> {
  const { data, error } = await supabase
    .from("lead_magnet_approvals")
    .select("*")
    .eq("client_id", clientId)
    .order("requested_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Every owed magnet and the one sentence saying why it has not gone. */
export async function fetchDeliveriesDue(clientId: string): Promise<LeadMagnetDue[]> {
  const { data, error } = await supabase
    .from("lead_magnet_due")
    .select("*")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

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

export async function fetchDeliverySwitch(clientId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("client_engine_settings")
    .select("lead_magnet_delivery_enabled")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.lead_magnet_delivery_enabled);
}

export async function setDeliveryEnabled(clientId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_lead_magnet_delivery_enabled", {
    p_client_id: clientId,
    p_enabled: enabled,
  });
  if (error) throw new Error(error.message);
}

export async function createMagnet(args: {
  clientId: string;
  name: string;
  objective: string;
  audience?: string | null;
  format: string;
  campaignId?: string | null;
  offerVersionId?: string | null;
}): Promise<string> {
  const { data, error } = await supabase
    .from("lead_magnets")
    .insert({
      client_id: args.clientId,
      name: args.name.trim(),
      objective: args.objective.trim(),
      audience: args.audience?.trim() || null,
      format: args.format,
      campaign_id: args.campaignId || null,
      offer_version_id: args.offerVersionId || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

/**
 * The hash of the bytes, computed here rather than trusted from anywhere.
 *
 * This is the number an approval is given against and the number the courier
 * re-checks before it attaches the file, so it has to come from the actual
 * file the person chose — not from a name, a size, or a server's opinion.
 */
export async function sha256Of(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload a file and record it as the next version of a magnet.
 *
 * A new file is always a new version. There is no edit: an approval names a
 * hash, and the row it names is immutable in the database for exactly that
 * reason.
 */
export async function addVersion(args: {
  clientId: string;
  magnetId: string;
  file: File;
  channel: "email" | "download_link";
  subject?: string | null;
  body?: string | null;
}): Promise<void> {
  const existing = await supabase
    .from("lead_magnet_versions")
    .select("version")
    .eq("magnet_id", args.magnetId)
    .order("version", { ascending: false })
    .limit(1);
  if (existing.error) throw new Error(existing.error.message);
  const version = (existing.data?.[0]?.version ?? 0) + 1;

  const hash = await sha256Of(args.file);
  const safeName = args.file.name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80);
  const path = `${args.clientId}/lead-magnets/${args.magnetId}/v${version}-${safeName}`;

  await uploadThen(MAGNET_BUCKET, path, args.file, async (storagePath) => {
    const { error } = await supabase.from("lead_magnet_versions").insert({
      magnet_id: args.magnetId,
      client_id: args.clientId,
      version,
      storage_path: storagePath,
      content_sha256: hash,
      file_bytes: args.file.size,
      media_type: args.file.type || "application/octet-stream",
      delivery_channel: args.channel,
      delivery_subject: args.subject?.trim() || null,
      delivery_body: args.body?.trim() || null,
    });
    if (error) throw new Error(error.message);
  });
}

export async function requestApproval(versionId: string): Promise<void> {
  const { error } = await supabase.rpc("request_lead_magnet_approval_v6", {
    p_version_id: versionId,
  });
  if (error) throw new Error(error.message);
}

export async function decideApproval(
  approvalId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("decide_lead_magnet_approval_v6", {
    p_approval_id: approvalId,
    p_approved: approved,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function revokeApproval(approvalId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_lead_magnet_approval_v6", {
    p_approval_id: approvalId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
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

/** The statuses that mean a person has the file. */
export const SENT_STATUSES: ReadonlySet<string> = new Set(["sent"]);
