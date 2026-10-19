import { supabase } from "./supabase";

/**
 * Proof Distribution, from the browser's side.
 *
 * A placement is one cleared piece of proof, present (or due to be present)
 * at one destination. It is the record that makes "where is this testimonial
 * used" and "this permission expired, what do we pull" answerable — neither
 * had an answer before migration 218.
 *
 * The four execution modes are the thing to keep in mind reading this file,
 * because the lifecycle genuinely differs between them:
 *
 *   api        the runtime calls an external API and owns the lifecycle
 *   embed      proof is bound into something another module publishes
 *   assisted   no write API exists, so a person places it and records where
 *   reference  proof is released to a live system that cites it
 *
 * Only `api` is ever claimed by a sweep. An assisted placement waits for a
 * person; an embed placement is marked placed by the page pipeline.
 */

/** 218's own wording, so the screen and the database say the same thing. */
export const MODE_HINT: Record<string, string> = {
  api: "The runtime posts it and owns what happens next.",
  embed: "Bound into a page, and published when that page is.",
  assisted: "No write API exists. A person places it and records where.",
  reference: "Released to a live system that cites it.",
};

export const PLACEMENT_STATUSES = [
  "drafted", "awaiting_approval", "approved", "queued", "placing",
  "awaiting_manual_placement", "bound", "placed", "verified",
  "failed", "rejected", "retraction_required", "retracted",
] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];

export interface Destination {
  destination_key: string;
  label: string;
  mode: string;
  provider: string | null;
  executor_module: string;
  supported: boolean;
  requires_integration: boolean;
  note: string;
}

export interface ClientDestination {
  destination_key: string;
  enabled: boolean;
  account_ref: string | null;
}

export interface Placement {
  id: string;
  client_id: string;
  destination_key: string;
  status: PlacementStatus;
  source_proof_id: string;
  artifact_version_id: string | null;
  proof_id: string | null;
  asset_id: string | null;
  approval_id: string | null;
  external_url: string | null;
  attempts: number;
  placed_at: string | null;
  created_at: string;
  last_error: string | null;
}

export interface PlacementDue {
  placement_id: string;
  destination_key: string;
  destination_label: string;
  mode: string;
  status: string;
  source_title: string | null;
  expires_on: string | null;
  blocker: string | null;
}

/**
 * `set_proof_publishing_enabled` arrives with migration 229 and is not in the
 * generated types until that is applied. One cast in one place, to delete
 * when they are regenerated.
 */
type UntypedRpc = (name: string, args: Record<string, unknown>) =>
  Promise<{ data: unknown; error: { message: string } | null }>;
const callRpc: UntypedRpc = (name, args) =>
  (supabase.rpc as unknown as UntypedRpc)(name, args);

export async function fetchDestinations(): Promise<Destination[]> {
  const { data, error } = await supabase
    .from("proof_destinations")
    .select("destination_key, label, mode, provider, executor_module, supported, requires_integration, note");
  if (error) throw new Error(error.message);
  // The playbook's order, not the alphabet: a person reading this list is
  // reading a journey from the client's own site outwards.
  const order = [
    "main_website", "seo_geo_content", "google_business_profile", "organic_social",
    "paid_advertising", "campaign_landing_page", "sales_conversation",
    "email_sms_nurture", "third_party_directory", "proposal_quotation",
  ];
  return ((data ?? []) as Destination[]).sort(
    (a, b) => order.indexOf(a.destination_key) - order.indexOf(b.destination_key),
  );
}

export async function fetchClientDestinations(clientId: string): Promise<Map<string, ClientDestination>> {
  const { data, error } = await supabase
    .from("client_proof_destinations")
    .select("destination_key, enabled, account_ref")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as ClientDestination[]).map((row) => [row.destination_key, row]));
}

export async function fetchPlacements(clientId: string): Promise<Placement[]> {
  const { data, error } = await supabase
    .from("proof_placements")
    .select("id, client_id, destination_key, status, source_proof_id, artifact_version_id, proof_id, asset_id, approval_id, external_url, attempts, placed_at, created_at, last_error")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Placement[];
}

export async function fetchPlacementDue(clientId: string): Promise<Map<string, PlacementDue>> {
  const { data, error } = await supabase
    .from("proof_placement_due")
    .select("placement_id, destination_key, destination_label, mode, status, source_title, expires_on, blocker")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as PlacementDue[]).map((row) => [row.placement_id, row]));
}

export async function setDestinationEnabled(
  clientId: string, destinationKey: string, enabled: boolean, accountRef?: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("client_proof_destinations")
    .upsert({
      client_id: clientId,
      destination_key: destinationKey,
      enabled,
      account_ref: accountRef ?? null,
      enabled_at: enabled ? new Date().toISOString() : null,
    }, { onConflict: "client_id,destination_key" });
  if (error) throw new Error(error.message);
}

export async function setProofPublishingEnabled(clientId: string, enabled: boolean): Promise<void> {
  const { error } = await callRpc("set_proof_publishing_enabled", {
    p_client_id: clientId, p_enabled: enabled,
  });
  if (error) throw new Error(error.message);
}

export async function createPlacement(args: {
  clientId: string;
  destinationKey: string;
  artifactVersionId?: string;
  proofId?: string;
  assetId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_proof_placement_v6", {
    // One placement per payload per destination per attempt at creating it.
    p_idempotency_key: `${args.destinationKey}:${args.artifactVersionId ?? args.proofId ?? args.assetId}`,
    p_client_id: args.clientId,
    p_destination_key: args.destinationKey,
    ...(args.artifactVersionId ? { p_artifact_version_id: args.artifactVersionId } : {}),
    ...(args.proofId ? { p_proof_id: args.proofId } : {}),
    ...(args.assetId ? { p_asset_id: args.assetId } : {}),
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function requestApproval(placementId: string): Promise<void> {
  const { error } = await supabase.rpc("request_proof_placement_approval_v6", {
    p_placement_id: placementId,
  });
  if (error) throw new Error(error.message);
}

export async function decideApproval(
  approvalId: string, approved: boolean, reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("decide_proof_placement_approval_v6", {
    p_approval_id: approvalId,
    p_approved: approved,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function markPlacedByHand(placementId: string, url: string): Promise<void> {
  const { error } = await supabase.rpc("mark_proof_placement_placed_v6", {
    p_placement_id: placementId, p_external_url: url,
  });
  if (error) throw new Error(error.message);
}

export async function recordRetracted(placementId: string, detail?: string): Promise<void> {
  const { error } = await supabase.rpc("record_proof_retracted_v6", {
    p_placement_id: placementId,
    ...(detail ? { p_detail: detail } : {}),
  });
  if (error) throw new Error(error.message);
}

/** The statuses that mean something is live, or was. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["placed", "verified"]);
/** The statuses that mean somebody has to go and take something down. */
export const RETRACTION_STATUSES: ReadonlySet<string> = new Set(["retraction_required"]);
