import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { supabase } from "../../lib/supabase";
import { downloadVerifiedMagnetFile } from "../../lib/leadMagnets";
import { downloadVerifiedProofFile } from "../../lib/proofRights";
import { downloadVerifiedCreativeFile } from "../../lib/creativeReview";
import { shouldShowExecutionEvidence, loadApprovalExecutionEvidence,
  type ApprovalExecutionEvidence } from "../../lib/approvalExecutionEvidence";
import type { Database } from "../../types/database";
import { ApprovalCoveragePanel } from "./ApprovalCoveragePanel";
import { ExternalExecutionAlerts } from "./ExternalExecutionAlerts";
import { HeldExternalJobs } from "./HeldExternalJobs";

const PAGE_SIZE = 50;
const RELEASED_SOURCE_KINDS = [
  "activation_switch", "campaign_action", "campaign_idea", "client_authority_assignment", "client_sales_entitlement", "creative_requirement", "engine_slot",
  "gateway_tool", "global_engine_activation", "global_video_owner", "google_profile_change", "google_review_reply", "integration_grant", "lead_magnet", "message_template", "meta_profile_change", "metrics_backfill", "motion_render", "nurture_sequence", "opportunity_activate", "opportunity_approve", "ordinary_media", "proof_artifact", "proof_delivery", "proof_placement", "proof_rights", "recruitment_brief", "sales_agent_public_use", "service_offer", "video_seat",
] as const;
type ApprovalViewRow = Database["public"]["Views"]["approval_inbox_v6"]["Row"];

/**
 * The read projection for B008. The owning source keeps its decision RPC;
 * this screen never turns a mirrored row into a second authority.
 */
export interface UnifiedApprovalRequest {
  id: string;
  client_id: string | null;
  source_system: string;
  source_kind: string;
  source_id: string;
  source_version: string;
  title: string;
  status: string;
  source_state?: string | null;
  requested_at: string;
  requested_by: string | null;
  requester_kind: string;
  requester_ref: string | null;
  expires_at: string | null;
  artifact_hash: string | null;
  preview: unknown;
  destination: string | null;
  account_ref: string | null;
  budget: unknown;
  scope: unknown;
  owner_role: string | null;
  preview_blocker: string | null;
  owning_path: string | null;
}

export interface UnifiedApprovalDecision {
  request_id: string;
  decision: string;
  actor_id: string | null;
  actor_aal: string | null;
  reason: string | null;
  decided_at: string;
  event_order?: number;
}

type GatewayOutcome = {
  approval_id: string;
  execution_status: string;
  claimed_at: string | null;
  finished_at: string | null;
  result_hash: string | null;
  sites_invocation_id: string | null;
  sites_invoked_at: string | null;
};

function validatedRequest(row: ApprovalViewRow): UnifiedApprovalRequest {
  for (const key of ["id", "source_system", "source_kind", "source_id",
    "source_version", "title", "status", "requested_at", "requester_kind"] as const) {
    if (typeof row[key] !== "string" || !row[key]?.trim()) {
      throw new Error(`Approval projection has no valid ${key}; this page cannot safely decide it.`);
    }
  }
  return row as UnifiedApprovalRequest;
}

function printable(value: unknown): string {
  if (value === null || value === undefined) return "Not supplied";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "Not supplied";
}

function dateLabel(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Reject untrusted or cross-client paths supplied by a projection row. */
function clientSourcePath(path: string | null, clientId: string): string | null {
  if (!path?.startsWith("/")) return null;
  try {
    const url = new URL(path, "https://approval-inbox.invalid");
    if (url.origin !== "https://approval-inbox.invalid"
      || !url.pathname.startsWith(`/clients/${encodeURIComponent(clientId)}/`)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function sourcePathForRequest(request: UnifiedApprovalRequest, clientId: string): string | null {
  if (request.source_system === "aa_console" && ["global_engine_activation", "global_video_owner"].includes(request.source_kind)
    && request.client_id === null && request.owner_role === "admin"
    && request.owning_path === "/approvals") return "/approvals";
  if (request.client_id !== clientId) return null;
  if (request.source_system === "aa_console"
    && request.source_kind === "recruitment_brief"
    && request.owner_role === "admin"
    && request.owning_path === "/team?tab=recruitment") {
    return request.owning_path;
  }
  return clientSourcePath(request.owning_path, clientId);
}

function previewMissing(request: UnifiedApprovalRequest): string | null {
  if (request.preview_blocker?.trim()) return request.preview_blocker;
  if (!request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)) {
    return "The exact artifact preview is missing.";
  }
  if (Object.keys(request.preview).length === 0) return "The exact artifact preview is empty.";
  if (!request.artifact_hash?.trim()) return "The artifact version hash is missing.";
  if (!request.source_version?.trim()) return "The source version is missing.";
  if (!request.expires_at) return "The approval expiry is missing.";
  if (!request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)
    || Object.keys(request.scope).length === 0) return "The exact scope is missing.";
  return null;
}

function isExpired(request: UnifiedApprovalRequest): boolean {
  return !request.expires_at || !Number.isFinite(Date.parse(request.expires_at))
    || Date.parse(request.expires_at) <= Date.now();
}

function isCampaignRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return request.source_system === "aa_console"
    && request.source_kind === "campaign_action"
    && request.client_id === clientId
    && (request.status === "pending" || request.status === "expired")
    && !previewMissing(request);
}

function isCampaignApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignRejectionReady(request, clientId)
    && request.status === "pending" && !isExpired(request);
}

function isGoogleReplyRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "google_review_reply"
    || request.client_id !== clientId
    || (request.status !== "pending" && request.status !== "expired")
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const location = preview.location_ref;
  const review = preview.review_ref;
  const bodyHash = preview.reply_body_sha256;
  return typeof location === "string" && !!location.trim()
    && typeof review === "string" && !!review.trim()
    && typeof preview.reply_body === "string" && !!preview.reply_body.trim()
    && typeof bodyHash === "string" && /^[0-9a-f]{64}$/.test(bodyHash)
    && request.source_version === request.artifact_hash
    && request.account_ref === location
    && request.destination === `google_business:${location}/reviews/${review}/reply`
    && scope.client_id === clientId && scope.reply_id === request.source_id
    && scope.review_id === preview.review_id && scope.review_ref === review
    && scope.location_ref === location && scope.body_hash === bodyHash;
}

function isGoogleReplyApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isGoogleReplyRejectionReady(request, clientId)
    && request.status === "pending" && !isExpired(request);
}

function isRecruitmentBriefApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "recruitment_brief"
    || request.client_id !== clientId || request.owner_role !== "admin"
    || request.status !== "pending" || isExpired(request) || previewMissing(request)
    || request.destination !== "internal:recruitment_ad_generation"
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return typeof request.artifact_hash === "string" && /^[0-9a-f]{64}$/.test(request.artifact_hash)
    && request.source_version.startsWith(`${request.artifact_hash}:v`)
    && /^[1-9][0-9]*$/.test(request.source_version.slice(request.artifact_hash.length + 2))
    && preview.id === request.source_id && preview.client_id === clientId
    && preview.purpose === "recruitment" && preview.media_type === "image"
    && typeof preview.title === "string" && !!preview.title.trim()
    && typeof preview.hook === "string" && !!preview.hook.trim()
    && typeof preview.script === "string" && !!preview.script.trim()
    && typeof preview.call_to_action === "string" && !!preview.call_to_action.trim()
    && typeof preview.apply_url === "string" && preview.apply_url.startsWith("https://")
    && scope.purpose === "recruitment"
    && scope.recruitment_role === preview.recruitment_role
    && scope.media_type === "image" && scope.apply_url === preview.apply_url;
}

function isSalesEntitlementRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "client_sales_entitlement"
    || request.owner_role !== "admin" || request.client_id !== clientId
    || !(["pending", "expired", "source_held"].includes(request.status))
    || !(["pending", "source_held"].includes(request.source_state ?? ""))
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const action = preview.action;
  const hash = request.source_version;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.source_id)
    && /^[0-9a-f]{64}$/.test(hash)
    && request.artifact_hash === hash && scope.scope_hash === hash
    && (action === "grant" || action === "revoke") && scope.action === action
    && request.title === (action === "grant" ? "Grant sales access" : "Revoke sales access")
    && typeof preview.client_name === "string" && !!preview.client_name.trim()
    && typeof preview.member_name === "string" && !!preview.member_name.trim()
    && preview.permission === "Read and manage this client's leads and conversations"
    && preview.client_id === clientId && scope.client_id === clientId
    && typeof preview.member_id === "string" && !!preview.member_id
    && scope.member_id === preview.member_id
    && typeof preview.bound_user_id === "string" && !!preview.bound_user_id
    && scope.bound_user_id === preview.bound_user_id
    && request.account_ref === preview.bound_user_id
    && request.destination === `client_sales_os:${clientId}`
    && request.requester_kind === "human" && !!request.requested_by;
}

function isSalesEntitlementApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isSalesEntitlementRejectionReady(request, clientId)
    && request.status === "pending" && request.source_state === "pending" && !isExpired(request);
}

function isServiceOfferRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "service_offer"
    || request.client_id !== clientId || !["pending", "expired", "source_held"].includes(request.status)
    || !["pending", "source_held"].includes(request.source_state ?? "")
    || previewMissing(request) || request.source_version !== request.artifact_hash
    || !request.artifact_hash || !/^[0-9a-f]{64}$/.test(request.artifact_hash)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return preview.offer_version_id === request.source_id
    && preview.client_id === clientId && scope.offer_version_id === request.source_id
    && scope.client_id === clientId && scope.offer_id === preview.offer_id
    && scope.version === preview.version && scope.content_hash === request.artifact_hash
    && request.destination === "campaign_factory:offer_version"
    && request.owner_role === "admin_or_active_client_manager"
    && typeof preview.service_name === "string" && !!preview.service_name.trim()
    && typeof preview.audience === "string" && !!preview.audience.trim()
    && typeof preview.promise === "string" && !!preview.promise.trim()
    && Array.isArray(preview.inclusions) && Array.isArray(preview.exclusions)
    && Array.isArray(preview.claims);
}

function isServiceOfferApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isServiceOfferRejectionReady(request, clientId)
    && request.status === "pending" && request.source_state === "pending" && !isExpired(request);
}

function isCampaignPreparationReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console"
    || request.source_kind !== "campaign_preparation_package"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || request.source_version !== request.artifact_hash
    || !request.artifact_hash || !/^[0-9a-f]{64}$/.test(request.artifact_hash)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return scope.package_id === request.source_id
    && scope.client_id === clientId && scope.campaign_id === preview.campaign_id
    && scope.run_id === preview.run_id && scope.snapshot_hash === request.artifact_hash
    && preview.client_id === clientId && Array.isArray(preview.routes)
    && Array.isArray(preview.outputs) && preview.outputs.length > 0
    && request.destination === "campaign_factory:prepared_package"
    && request.owner_role === "admin_or_active_client_manager";
}

function isGoogleOperatorBundleReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "google_operator_bundle"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || request.source_version !== request.artifact_hash
    || !request.artifact_hash || !/^[0-9a-f]{64}$/.test(request.artifact_hash)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const source = preview.source;
  return scope.bundle_id === request.source_id && scope.client_id === clientId
    && scope.campaign_id === (source as Record<string, unknown> | undefined)?.campaign_id
    && scope.sheet_id === (source as Record<string, unknown> | undefined)?.sheet_id
    && scope.snapshot_hash === request.artifact_hash
    && typeof preview.owner === "string" && preview.owner.length > 0
    && Array.isArray(preview.headlines) && preview.headlines.length >= 3
    && Array.isArray(preview.descriptions) && preview.descriptions.length >= 2
    && request.destination === "google_ads:manual_operator_handoff"
    && request.owner_role === "admin_or_active_client_manager";
}

function isGoogleSearchCopyReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "google_search_copy"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || request.source_version !== request.artifact_hash
    || !request.artifact_hash || !/^[0-9a-f]{64}$/.test(request.artifact_hash)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return scope.copy_id === request.source_id && scope.client_id === clientId
    && scope.campaign_id === preview.campaign_id
    && scope.route_package_id === preview.route_package_id
    && scope.work_item_id === preview.work_item_id
    && scope.copy_hash === request.artifact_hash
    && preview.copy_hash === request.artifact_hash
    && Array.isArray(preview.headlines) && preview.headlines.length >= 3
    && Array.isArray(preview.descriptions) && preview.descriptions.length >= 2
    && typeof preview.rationale === "string" && preview.rationale.length >= 20
    && request.destination === "google_ads:manual_operator_handoff"
    && request.owner_role === "admin_or_active_client_manager";
}

function isPaidOperatorBundleReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "paid_operator_bundle"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || request.source_version !== request.artifact_hash
    || !request.artifact_hash || !/^[0-9a-f]{64}$/.test(request.artifact_hash)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const source = preview.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const packet = source as Record<string, unknown>;
  return scope.bundle_id === request.source_id && scope.client_id === clientId
    && scope.campaign_id === packet.campaign_id
    && scope.package_id === packet.package_id
    && scope.platform === packet.platform
    && scope.snapshot_hash === request.artifact_hash
    && typeof preview.operator === "string" && preview.operator.trim().length > 0
    && typeof preview.budget_instruction === "string"
    && preview.budget_instruction.trim().length > 0
    && typeof preview.tracking_instruction === "string"
    && preview.tracking_instruction.trim().length > 0
    && (packet.platform !== "google" || (typeof preview.research_task === "string"
      && preview.research_task.trim().length > 0))
    && Array.isArray(packet.creative) && packet.creative.length > 0
    && (packet.platform === "meta" || packet.platform === "google")
    && request.destination === `${packet.platform}_ads:manual_operator_handoff`
    && request.owner_role === "admin_or_active_client_manager";
}

function isLeadMagnetApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "lead_magnet"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || request.source_version !== request.artifact_hash
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  return typeof request.artifact_hash === "string" && /^[0-9a-f]{64}$/.test(request.artifact_hash)
    && preview.approval_id === request.source_id && preview.client_id === clientId
    && scope.approval_id === request.source_id && scope.client_id === clientId
    && scope.magnet_version_id === preview.magnet_version_id
    && scope.content_sha256 === preview.content_sha256
    && scope.payload_hash === request.artifact_hash
    && preview.verified_content_sha256 === preview.content_sha256
    && preview.verified_file_bytes === preview.file_bytes
    && typeof preview.verified_at === "string"
    && typeof preview.storage_path === "string" && !!preview.storage_path
    && typeof preview.content_sha256 === "string" && /^[0-9a-f]{64}$/.test(preview.content_sha256)
    && typeof preview.file_bytes === "number" && preview.file_bytes > 0
    && request.destination === `lead_magnet:${preview.delivery_channel}`
    && scope.delivery_channel === preview.delivery_channel
    && scope.recipient_scope === "consented_opt_ins"
    && request.owner_role === "admin_or_active_client_manager";
}

function isSalesAgentRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "sales_agent_public_use"
    || request.client_id !== clientId || !["pending", "source_held", "expired"].includes(request.status)
    || !["pending", "source_held"].includes(request.source_state ?? "")
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.agent_id === request.source_id && preview.client_id === clientId
    && preview.status === "live" && typeof preview.built_at === "string"
    && typeof preview.page_id === "string" && !!preview.page_id
    && typeof preview.system_prompt === "string" && !!preview.system_prompt.trim()
    && typeof preview.greeting === "string" && !!preview.greeting.trim()
    && typeof preview.guardrails === "string" && !!preview.guardrails.trim()
    && Array.isArray(preview.qualification) && Array.isArray(preview.objections)
    && scope.agent_id === request.source_id && scope.client_id === clientId
    && scope.page_id === preview.page_id && scope.request_token === preview.request_token
    && scope.script_hash === hash
    && request.destination === `public_sales_agent:${request.source_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isSalesAgentApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isSalesAgentRejectionReady(request, clientId)
    && request.status === "pending" && request.source_state === "pending" && !isExpired(request);
}

function isOpportunityRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "opportunity_approve"
    || request.client_id !== clientId || !["pending", "source_held", "expired"].includes(request.status)
    || !["pending", "source_held"].includes(request.source_state ?? "")
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const opportunity = preview.opportunity;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.opportunity_id === request.source_id && preview.client_id === clientId
    && !!opportunity && typeof opportunity === "object" && !Array.isArray(opportunity)
    && typeof (opportunity as Record<string, unknown>).name === "string"
    && !!(opportunity as Record<string, unknown>).name
    && !!preview.score && typeof preview.score === "object"
    && Array.isArray(preview.attributes) && Array.isArray(preview.awareness)
    && Array.isArray(preview.links) && Array.isArray(preview.proof_requirements)
    && scope.opportunity_id === request.source_id && scope.client_id === clientId
    && scope.request_token === preview.request_token && scope.content_hash === hash
    && request.destination === `campaign_factory:opportunity:${request.source_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isOpportunityApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isOpportunityRejectionReady(request, clientId)
    && request.status === "pending" && request.source_state === "pending" && !isExpired(request);
}

function isProofRightsRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "proof_rights"
    || request.client_id !== clientId || !["pending", "source_held", "expired"].includes(request.status)
    || !["pending", "source_held"].includes(request.source_state ?? "")
    || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const proof = preview.proof;
  const hash = request.artifact_hash;
  const source = proof && typeof proof === "object" && !Array.isArray(proof)
    ? proof as Record<string, unknown> : null;
  const textSource = source?.media_type === "text" && source.storage_path == null;
  const verifiedMedia = (source?.media_type === "image" || source?.media_type === "video")
    && typeof source.storage_path === "string" && !!source.storage_path
    && preview.verified_storage_path === source.storage_path
    && typeof preview.verified_storage_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(preview.verified_storage_sha256)
    && typeof preview.verified_file_bytes === "number" && preview.verified_file_bytes > 0
    && typeof preview.verified_storage_object_id === "string"
    && typeof preview.verified_storage_object_updated_at === "string";
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.proof_id === "string"
    && source?.id === preview.proof_id && (textSource || verifiedMedia)
    && preview.requested_rights === "approved"
    && typeof preview.permission_basis === "string" && !!preview.permission_basis.trim()
    && scope.rights_request_id === request.source_id && scope.client_id === clientId
    && scope.proof_id === preview.proof_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.requested_rights === "approved"
    && request.destination === `proof_bank:clear:${preview.proof_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isProofRightsApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isProofRightsRejectionReady(request, clientId)
    && request.status === "pending" && request.source_state === "pending" && !isExpired(request);
}

function isProofPlacementReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "proof_placement"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const proof = preview.source_proof;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.approval_id === request.source_id
    && typeof preview.placement_id === "string" && !!preview.placement_id
    && typeof preview.destination_key === "string" && !!preview.destination_key
    && typeof preview.placement_payload_hash === "string"
    && !!proof && typeof proof === "object" && !Array.isArray(proof)
    && (proof as Record<string, unknown>).media_type === "text"
    && (proof as Record<string, unknown>).storage_path == null
    && preview.payload_proof != null && preview.artifact == null && preview.media == null
    && scope.client_id === clientId && scope.approval_id === request.source_id
    && scope.placement_id === preview.placement_id
    && scope.request_token === preview.request_token
    && scope.destination_key === preview.destination_key
    && scope.content_hash === hash && scope.effect === "release_for_placement"
    && request.destination === `proof_distribution:${preview.destination_key}:${preview.placement_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isProofArtifactReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "proof_artifact"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const artifact = preview.artifact;
  const source = preview.source_proof;
  const hash = request.artifact_hash;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || !source || typeof source !== "object" || Array.isArray(source)) return false;
  const version = artifact as Record<string, unknown>;
  const proof = source as Record<string, unknown>;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.artifact_version_id === version.id
    && version.client_id === clientId && typeof version.content === "string"
    && !!version.content.trim() && typeof version.supported_claim === "string"
    && typeof version.evidence_excerpt === "string"
    && proof.id === version.source_proof_id && proof.client_id === clientId
    && proof.usage_rights === "approved" && !!proof.approved_rights_request_id
    && scope.client_id === clientId && scope.review_id === request.source_id
    && scope.artifact_version_id === version.id
    && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "source_and_claim_signoff"
    && request.destination === `proof_bank:artifact:${version.id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isOrdinaryMediaReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "ordinary_media"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  if (!preview.asset || typeof preview.asset !== "object" || Array.isArray(preview.asset)
    || !preview.storage || typeof preview.storage !== "object" || Array.isArray(preview.storage)) return false;
  const asset = preview.asset as Record<string, unknown>;
  const storage = preview.storage as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.asset_id === asset.id
    && asset.client_id === clientId && (asset.media_type === "image" || asset.media_type === "text")
    && asset.content_format === "single" && typeof asset.storage_path === "string"
    && !!asset.storage_path && typeof asset.file_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(asset.file_sha256)
    && typeof asset.usage_rights === "string" && !!asset.usage_rights
    && storage.bucket === "client-media" && typeof storage.object_id === "string"
    && scope.client_id === clientId && scope.asset_id === asset.id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "creative_source_signoff"
    && request.destination === `creative_source:${asset.id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isProofDeliveryReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "proof_delivery"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.delivery_id === "string"
    && typeof preview.recipient === "string" && !!preview.recipient
    && typeof preview.message === "string" && !!preview.message
    && typeof preview.capture_url === "string" && !!preview.capture_url
    && ["email", "sms", "whatsapp"].includes(String(preview.channel))
    && typeof preview.link_id === "string" && !!preview.link_id
    && typeof preview.config_id === "string" && !!preview.config_id
    && scope.client_id === clientId && scope.delivery_id === preview.delivery_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "proof_request_send"
    && request.destination === `${preview.channel}:${preview.recipient}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isMetaProfileChangeReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "meta_profile_change"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.change_id === "string"
    && ["instagram", "facebook"].includes(String(preview.platform))
    && typeof preview.field === "string" && !!preview.field
    && typeof preview.proposed_value === "string" && !!preview.proposed_value
    && scope.client_id === clientId && scope.change_id === preview.change_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "meta_profile_proposal_only"
    && request.destination === `meta_profile:${preview.platform}:${preview.field}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isGoogleProfileChangeReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "google_profile_change"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.change_id === "string"
    && typeof preview.location_id === "string" && !!preview.location_id
    && typeof preview.location_ref === "string" && !!preview.location_ref
    && typeof preview.field === "string" && !!preview.field
    && typeof preview.proposed_value === "string" && !!preview.proposed_value
    && scope.client_id === clientId && scope.change_id === preview.change_id
    && scope.location_id === preview.location_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "google_profile_proposal_only"
    && request.destination === `google_profile:${preview.location_ref}:${preview.field}`
    && request.account_ref === preview.location_ref
    && request.owner_role === "admin_or_active_client_manager";
}

function isOpportunityActivationReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "opportunity_activate"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.opportunity_id === "string"
    && typeof preview.approved_request_id === "string" && !!preview.approved_request_id
    && typeof preview.approved_content_hash === "string"
    && /^[0-9a-f]{64}$/.test(preview.approved_content_hash)
    && typeof preview.approved_opportunity === "object" && preview.approved_opportunity !== null
    && !Array.isArray(preview.approved_opportunity) && Array.isArray(preview.campaigns)
    && scope.client_id === clientId && scope.opportunity_id === preview.opportunity_id
    && scope.activation_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "opportunity_status_active"
    && request.destination === `market_opportunity:${preview.opportunity_id}:active`
    && request.owner_role === "admin_or_active_client_manager";
}

function isMessageTemplateReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "message_template"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.template_version_id === "string"
    && typeof preview.name === "string" && !!preview.name
    && typeof preview.purpose === "string" && !!preview.purpose
    && typeof preview.channel === "string" && !!preview.channel
    && typeof preview.body === "string" && !!preview.body
    && typeof preview.consent_basis === "string" && !!preview.consent_basis
    && preview.channel_supported === true
    && scope.client_id === clientId && scope.template_version_id === preview.template_version_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "standing_template_send_permission"
    && request.destination === `outbound_template:${preview.channel}:${preview.template_version_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isNurtureSequenceReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "nurture_sequence"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.sequence_id === "string"
    && typeof preview.name === "string" && !!preview.name
    && typeof preview.purpose === "string" && !!preview.purpose
    && typeof preview.trigger_stage === "string" && !!preview.trigger_stage
    && typeof preview.trigger_after_hours === "number"
    && Array.isArray(preview.exit_stages)
    && typeof preview.enrolled_automatically === "boolean"
    && Array.isArray(preview.steps) && preview.steps.length > 0
    && preview.steps.every((value) => value && typeof value === "object"
      && typeof value.template_version_id === "string"
      && typeof value.body === "string" && !!value.body
      && typeof value.approval_request_id === "string" && !!value.approval_request_id)
    && scope.client_id === clientId && scope.sequence_id === preview.sequence_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "standing_sequence_enrolment_permission"
    && request.destination === `nurture_sequence:${preview.sequence_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isVideoSeatReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "video_seat"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  if (!preview.asset || typeof preview.asset !== "object" || Array.isArray(preview.asset)
    || !preview.storage || typeof preview.storage !== "object" || Array.isArray(preview.storage)) return false;
  const asset = preview.asset as Record<string, unknown>;
  const storage = preview.storage as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && typeof preview.request_token === "string" && !!preview.request_token
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.asset_id === "string"
    && ["owner", "manager", "client"].includes(String(preview.approval_role))
    && typeof preview.assigned_reviewer === "string" && !!preview.assigned_reviewer
    && asset.media_type === "video" && asset.edit_stage === "review_ready"
    && typeof asset.render_path === "string" && !!asset.render_path
    && typeof asset.file_sha256 === "string" && /^[0-9a-f]{64}$/.test(asset.file_sha256)
    && typeof asset.usage_rights === "string" && !!asset.usage_rights
    && storage.bucket === "client-media" && typeof storage.object_id === "string"
    && scope.client_id === clientId && scope.asset_id === preview.asset_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "rendered_video_seat_signoff"
    && scope.approval_role === preview.approval_role
    && scope.assigned_reviewer === preview.assigned_reviewer
    && request.destination === `video_seat:${preview.approval_role}:${preview.asset_id}`
    && request.owner_role === `video_${preview.approval_role}:${preview.assigned_reviewer}`;
}

function isMotionRenderReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "motion_render"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const qa = preview.qa && typeof preview.qa === "object" && !Array.isArray(preview.qa)
    ? preview.qa as Record<string, unknown> : null;
  const storage = preview.storage && typeof preview.storage === "object" && !Array.isArray(preview.storage)
    ? preview.storage as Record<string, unknown> : null;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && typeof preview.candidate_id === "string"
    && typeof preview.project_id === "string" && typeof preview.render_path === "string"
    && typeof preview.render_sha256 === "string" && /^[0-9a-f]{64}$/.test(preview.render_sha256)
    && typeof preview.render_file_bytes === "number" && preview.render_file_bytes > 0
    && qa?.brand === "pass" && qa?.claim === "pass"
    && storage?.bucket === "client-media" && typeof storage.object_id === "string"
    && Array.isArray(preview.scenes)
    && scope.client_id === clientId && scope.candidate_id === preview.candidate_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "motion_candidate_acceptance"
    && request.destination === `motion_render:${preview.candidate_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

function isCampaignIdeaReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "campaign_idea"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const idea = preview.idea && typeof preview.idea === "object" && !Array.isArray(preview.idea)
    ? preview.idea as Record<string, unknown> : null;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.selection_route === "human"
    && typeof preview.idea_id === "string" && !!preview.idea_id
    && idea?.id === preview.idea_id && idea?.client_id === clientId
    && typeof idea.title === "string" && !!idea.title.trim()
    && scope.client_id === clientId && scope.idea_id === preview.idea_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "human_idea_selection_for_brief"
    && request.destination === `internal:brief:idea:${preview.idea_id}`
    && request.owner_role === "admin_or_active_client_manager";
}

const SWITCH_COLUMNS: Record<string, string> = {
  engine: "enabled", auto_approve_ideas: "auto_approve_ideas",
  auto_approve_briefs: "auto_approve_briefs", publishing: "publishing_enabled",
  proof_publishing: "proof_publishing_enabled",
  campaign_actions: "campaign_actions_enabled",
  outbound_messaging: "outbound_messaging_enabled",
  lead_magnet_delivery: "lead_magnet_delivery_enabled",
  booking: "enabled",
};

function isClientSwitchActivationReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "activation_switch"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const settings = preview.settings && typeof preview.settings === "object" && !Array.isArray(preview.settings)
    ? preview.settings as Record<string, unknown> : null;
  const endpoint = preview.endpoint && typeof preview.endpoint === "object" && !Array.isArray(preview.endpoint)
    ? preview.endpoint as Record<string, unknown> : null;
  const key = preview.switch_key;
  const column = typeof key === "string" ? SWITCH_COLUMNS[key] : undefined;
  const hash = request.artifact_hash;
  const targetId = key === "lead_capture" && typeof preview.target_id === "string"
    ? preview.target_id : null;
  const targetReady = key === "lead_capture"
    ? !!targetId && endpoint?.id === targetId && endpoint?.client_id === clientId
      && endpoint.enabled === false && endpoint.revoked_at === null
      && typeof endpoint.token_hash === "string" && /^[0-9a-f]{64}$/.test(endpoint.token_hash)
      && typeof endpoint.consent_wording === "string" && !!endpoint.consent_wording.trim()
      && typeof endpoint.expires_at === "string"
      && typeof endpoint.max_submissions === "number" && typeof endpoint.submissions === "number"
      && endpoint.submissions < endpoint.max_submissions
    : !!column && settings?.client_id === clientId && settings[column] === false
      && (key !== "booking" || (Array.isArray(preview.windows) && preview.windows.length > 0));
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.action === "enable"
    && typeof key === "string" && targetReady
    && scope.client_id === clientId && scope.switch_key === key
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && (targetId === null || scope.target_id === targetId)
    && scope.content_hash === hash && scope.effect === "enable_client_automation_switch"
    && request.destination === `client:automation:${clientId}:${key}${targetId ? `:${targetId}` : ""}`
    && request.owner_role === "admin";
}

function isGlobalEngineActivationReady(request: UnifiedApprovalRequest): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "global_engine_activation"
    || request.client_id !== null || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const control = preview.global_control && typeof preview.global_control === "object"
    && !Array.isArray(preview.global_control)
    ? preview.global_control as Record<string, unknown> : null;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.action === "enable_system_engine" && control?.enabled === false
    && Array.isArray(preview.client_scope)
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.effect === "enable_global_content_engine"
    && request.destination === "system:content_engine" && request.owner_role === "admin";
}

function isGlobalVideoOwnerReady(request: UnifiedApprovalRequest): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "global_video_owner"
    || request.client_id !== null || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.action === "assign_global_video_approval_owner"
    && typeof preview.proposed_owner === "string" && !!preview.proposed_owner
    && preview.proposed_owner_role === "admin"
    && preview.current_owner !== preview.proposed_owner
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.proposed_owner === preview.proposed_owner
    && scope.effect === "change_global_video_approval_owner"
    && request.destination === "agency:video_approval_owner"
    && request.owner_role === "admin" && request.owning_path === "/approvals";
}

function isIntegrationGrantReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "integration_grant"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.action === "grant_provider_access"
    && typeof preview.integration_id === "string" && !!preview.integration_id
    && typeof preview.provider === "string" && !!preview.provider
    && typeof preview.account_label === "string" && !!preview.account_label
    && ["read", "write", "admin"].includes(String(preview.access_level))
    && typeof preview.credential_version_hash === "string"
    && /^[0-9a-f]{64}$/.test(preview.credential_version_hash)
    && typeof preview.enable_daily_ingest === "boolean"
    && (preview.recorded_status === "pending_grant"
      || (preview.enable_daily_ingest === true
        && ["connected", "active", "expiring"].includes(String(preview.recorded_status))))
    && scope.client_id === clientId && scope.integration_id === preview.integration_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.enable_daily_ingest === preview.enable_daily_ingest
    && scope.content_hash === hash && scope.effect === "grant_client_provider_credential_use"
    && request.destination === `client:integration:${clientId}:${preview.integration_id}`
    && request.account_ref === preview.account_label && request.owner_role === "admin";
}

function isMetricsBackfillReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "metrics_backfill"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.action === "pull_metrics_history"
    && typeof preview.since === "string" && typeof preview.until === "string"
    && ["both", "paid", "organic"].includes(String(preview.surface))
    && Array.isArray(preview.accounts)
    && preview.accounts.length === (preview.surface === "both" ? 2 : 1)
    && preview.accounts.every((a) => a && typeof a === "object"
      && typeof a.credential_version_hash === "string"
      && /^[0-9a-f]{64}$/.test(a.credential_version_hash))
    && scope.client_id === clientId && scope.review_id === request.source_id
    && scope.request_token === preview.request_token && scope.content_hash === hash
    && scope.effect === "queue_metrics_backfill" && scope.surfaces === preview.surface
    && scope.since === preview.since && scope.until === preview.until
    && request.destination === `client:metrics:${clientId}:${preview.surface}`
    && request.owner_role === "admin";
}

function isCreativeRequirementReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "creative_requirement"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && preview.action === "change_creative_approval_requirement"
    && typeof preview.current_required === "boolean"
    && typeof preview.proposed_required === "boolean"
    && preview.current_required !== preview.proposed_required
    && (preview.proposed_required === false
      || (typeof preview.current_creative_director === "string"
        && !!preview.current_creative_director))
    && scope.client_id === clientId && scope.review_id === request.source_id
    && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.proposed_required === preview.proposed_required
    && scope.effect === "change_creative_approval_authority"
    && request.destination === `client:creative_authority:${clientId}`
    && request.owner_role === "admin";
}

function isClientAuthorityAssignmentReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "client_authority_assignment"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const member = preview.member && typeof preview.member === "object" && !Array.isArray(preview.member)
    ? preview.member as Record<string, unknown> : null;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && preview.client_id === clientId && ["assign", "end"].includes(String(preview.action))
    && typeof preview.member_id === "string" && !!preview.member_id
    && member?.id === preview.member_id
    && ["smm", "creative_director"].includes(String(member.category))
    && scope.client_id === clientId && scope.member_id === preview.member_id
    && scope.review_id === request.source_id && scope.request_token === preview.request_token
    && scope.content_hash === hash && scope.action === preview.action
    && scope.effect === "change_client_approval_seat"
    && request.destination === `client:approval_seat:${clientId}:${preview.member_id}`
    && request.owner_role === "admin";
}

function isGatewayToolReady(request: UnifiedApprovalRequest, clientId: string,
  mode: "pending" | "approved" = "pending"): boolean {
  const pending = mode === "pending";
  if (request.source_system !== "aa_console" || request.source_kind !== "gateway_tool"
    || request.client_id !== clientId || request.status !== mode
    || request.source_state !== (pending ? "pending" : "source_decided")
    || (pending && isExpired(request)) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  const hash = request.artifact_hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    && request.source_version === `${hash}:${preview.request_token}`
    && request.source_id === preview.gateway_approval_id
    && preview.client_id === clientId
    && typeof preview.bot_id === "string" && /^bot_[a-z0-9_]+$/.test(preview.bot_id)
    && typeof preview.tool === "string" && /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(preview.tool)
    && typeof preview.token_id === "string" && !!preview.token_id
    && typeof preview.payload_hash === "string" && /^[0-9a-f]{64}$/.test(preview.payload_hash)
    && !!preview.structured_payload && typeof preview.structured_payload === "object"
    && !Array.isArray(preview.structured_payload)
    && scope.client_id === clientId && scope.gateway_approval_id === request.source_id
    && scope.bot_id === preview.bot_id && scope.token_id === preview.token_id
    && scope.tool === preview.tool && scope.payload_hash === preview.payload_hash
    && scope.content_hash === hash && scope.request_token === preview.request_token
    && scope.effect === "allow_one_gateway_tool_execution"
    && request.destination === `gateway:${preview.bot_id}:${preview.tool}`
    && request.owner_role === "admin";
}

function isGatewayToolRevocable(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isGatewayToolReady(request, clientId, "approved");
}

function isEngineSlotReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  if (request.source_system !== "aa_console" || request.source_kind !== "engine_slot"
    || request.client_id !== clientId || request.status !== "pending"
    || request.source_state !== "pending" || isExpired(request) || previewMissing(request)
    || !request.preview || typeof request.preview !== "object" || Array.isArray(request.preview)
    || !request.scope || typeof request.scope !== "object" || Array.isArray(request.scope)) return false;
  const preview = request.preview as Record<string, unknown>;
  const scope = request.scope as Record<string, unknown>;
  if (!preview.exact_package || typeof preview.exact_package !== "object"
    || Array.isArray(preview.exact_package)) return false;
  const packet = preview.exact_package as Record<string, unknown>;
  if (!packet.slot || typeof packet.slot !== "object" || Array.isArray(packet.slot)
    || !packet.asset || typeof packet.asset !== "object" || Array.isArray(packet.asset)
    || !packet.storage || typeof packet.storage !== "object" || Array.isArray(packet.storage)) return false;
  const slot = packet.slot as Record<string, unknown>;
  const asset = packet.asset as Record<string, unknown>;
  const storage = packet.storage as Record<string, unknown>;
  return typeof request.artifact_hash === "string"
    && /^[0-9a-f]{64}$/.test(request.artifact_hash)
    && request.source_version === scope.approval_entry_id
    && request.source_id === slot.id && slot.id === scope.slot_id
    && slot.asset_id === asset.id && asset.id === scope.asset_id
    && slot.platform === scope.platform && slot.scheduled_at === scope.scheduled_at
    && packet.client_id === clientId && asset.client_id === clientId
    && scope.client_id === clientId && asset.content_format === "single"
    && (asset.media_type === "image" || asset.media_type === "text")
    && typeof asset.storage_path === "string" && !!asset.storage_path
    && typeof asset.file_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(asset.file_sha256)
    && typeof asset.usage_rights === "string" && !!asset.usage_rights
    && storage.bucket === "client-media" && typeof storage.object_id === "string"
    && Array.isArray(packet.post_copy) && packet.post_copy.length > 0
    && typeof packet.account_ref === "string" && !!packet.account_ref
    && request.account_ref === packet.account_ref
    && request.destination === `organic:${slot.platform}`
    && request.owner_role === "client_media_reviewer";
}

function isRejectionReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignPreparationReady(request, clientId)
    || isPaidOperatorBundleReady(request, clientId)
    || isGoogleSearchCopyReady(request, clientId)
    || isGoogleOperatorBundleReady(request, clientId)
    || isCampaignRejectionReady(request, clientId)
    || isGoogleReplyRejectionReady(request, clientId)
    || isSalesEntitlementRejectionReady(request, clientId)
    || isServiceOfferRejectionReady(request, clientId)
    || isLeadMagnetApprovalReady(request, clientId)
    || isSalesAgentRejectionReady(request, clientId)
    || isOpportunityRejectionReady(request, clientId)
    || isProofRightsRejectionReady(request, clientId)
    || isProofPlacementReady(request, clientId)
    || isProofArtifactReady(request, clientId)
    || isEngineSlotReady(request, clientId)
    || isOrdinaryMediaReady(request, clientId)
    || isProofDeliveryReady(request, clientId)
    || isMetaProfileChangeReady(request, clientId)
    || isGoogleProfileChangeReady(request, clientId)
    || isOpportunityActivationReady(request, clientId)
    || isMessageTemplateReady(request, clientId)
    || isNurtureSequenceReady(request, clientId)
    || isVideoSeatReady(request, clientId)
    || isMotionRenderReady(request, clientId)
    || isCampaignIdeaReady(request, clientId)
    || isClientSwitchActivationReady(request, clientId)
    || isIntegrationGrantReady(request, clientId)
    || isMetricsBackfillReady(request, clientId)
    || isCreativeRequirementReady(request, clientId)
    || isClientAuthorityAssignmentReady(request, clientId)
    || isGatewayToolReady(request, clientId)
    || isGlobalEngineActivationReady(request)
    || isGlobalVideoOwnerReady(request);
}

function isApprovalReady(request: UnifiedApprovalRequest, clientId: string): boolean {
  return isCampaignPreparationReady(request, clientId)
    || isPaidOperatorBundleReady(request, clientId)
    || isGoogleSearchCopyReady(request, clientId)
    || isGoogleOperatorBundleReady(request, clientId)
    || isCampaignApprovalReady(request, clientId)
    || isGoogleReplyApprovalReady(request, clientId)
    || isRecruitmentBriefApprovalReady(request, clientId)
    || isSalesEntitlementApprovalReady(request, clientId)
    || isServiceOfferApprovalReady(request, clientId)
    || isLeadMagnetApprovalReady(request, clientId)
    || isSalesAgentApprovalReady(request, clientId)
    || isOpportunityApprovalReady(request, clientId)
    || isProofRightsApprovalReady(request, clientId)
    || isProofPlacementReady(request, clientId)
    || isProofArtifactReady(request, clientId)
    || isEngineSlotReady(request, clientId)
    || isOrdinaryMediaReady(request, clientId)
    || isProofDeliveryReady(request, clientId)
    || isMetaProfileChangeReady(request, clientId)
    || isGoogleProfileChangeReady(request, clientId)
    || isOpportunityActivationReady(request, clientId)
    || isMessageTemplateReady(request, clientId)
    || isNurtureSequenceReady(request, clientId)
    || isVideoSeatReady(request, clientId)
    || isMotionRenderReady(request, clientId)
    || isCampaignIdeaReady(request, clientId)
    || isClientSwitchActivationReady(request, clientId)
    || isIntegrationGrantReady(request, clientId)
    || isMetricsBackfillReady(request, clientId)
    || isCreativeRequirementReady(request, clientId)
    || isClientAuthorityAssignmentReady(request, clientId)
    || isGatewayToolReady(request, clientId)
    || isGlobalEngineActivationReady(request)
    || isGlobalVideoOwnerReady(request);
}

function sameVersion(left: UnifiedApprovalRequest, right: UnifiedApprovalRequest): boolean {
  return left.id === right.id && left.source_id === right.source_id
    && left.client_id === right.client_id && left.source_system === right.source_system
    && left.source_kind === right.source_kind && left.owner_role === right.owner_role
    && left.title === right.title && left.requested_at === right.requested_at
    && left.requested_by === right.requested_by
    && left.requester_kind === right.requester_kind
    && left.requester_ref === right.requester_ref
    && left.owning_path === right.owning_path
    && left.source_version === right.source_version
    && left.status === right.status
    && left.source_state === right.source_state
    && left.expires_at === right.expires_at
    && left.artifact_hash === right.artifact_hash
    && left.destination === right.destination
    && left.account_ref === right.account_ref
    && left.preview_blocker === right.preview_blocker
    && JSON.stringify(left.preview) === JSON.stringify(right.preview)
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.budget) === JSON.stringify(right.budget);
}

function statusTone(status: string): string {
  switch (status.toLowerCase()) {
    case "pending": return "border-amber-300 bg-amber-50 text-amber-900";
    case "approved": return "border-green-300 bg-green-50 text-green-900";
    case "rejected": return "border-red-300 bg-red-50 text-red-900";
    case "stale": return "border-red-300 bg-red-50 text-red-900";
    default: return "border-border bg-muted text-foreground";
  }
}

function exactHtml(preview: unknown): string | null {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const html = (preview as Record<string, unknown>).rendered_html;
  return typeof html === "string" && html.trim() ? html : null;
}

function RequestCard({ request, history, gatewayOutcome, executionEvidence, clientId, manager, aal, busy, onDecide }: {
  request: UnifiedApprovalRequest;
  history: UnifiedApprovalDecision[];
  gatewayOutcome?: GatewayOutcome;
  executionEvidence?: ApprovalExecutionEvidence;
  clientId: string;
  manager: boolean;
  aal: "aal2" | "aal1" | "unavailable";
  busy: boolean;
  onDecide: (request: UnifiedApprovalRequest, decision: "approved" | "rejected" | "revoked", reason?: string) => Promise<void>;
}) {
  const [rejectionReason, setRejectionReason] = useState("");
  const [downloadedMagnetHash, setDownloadedMagnetHash] = useState<string | null>(null);
  const [downloadedProofHash, setDownloadedProofHash] = useState<string | null>(null);
  const [downloadedCreativeHash, setDownloadedCreativeHash] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const location = useLocation();
  const blocker = previewMissing(request);
  const sourcePath = manager ? null : sourcePathForRequest(request, clientId);
  const html = exactHtml(request.preview);
  const salesGrant = request.source_kind === "client_sales_entitlement"
    && request.preview !== null && typeof request.preview === "object"
    && !Array.isArray(request.preview)
    && (request.preview as Record<string, unknown>).action === "grant";
  const salesManagerCard = manager && request.source_kind === "client_sales_entitlement";
  const proofRightsPreview = request.source_kind === "proof_rights" && request.preview
    && typeof request.preview === "object" && !Array.isArray(request.preview)
    ? request.preview as Record<string, unknown> : null;
  const proofMediaDownloadable = !!proofRightsPreview
    && typeof proofRightsPreview.verified_storage_path === "string"
    && typeof proofRightsPreview.verified_storage_sha256 === "string"
    && typeof proofRightsPreview.verified_file_bytes === "number";
  const creativePreview = (request.source_kind === "ordinary_media"
    || request.source_kind === "engine_slot" || request.source_kind === "video_seat"
    || request.source_kind === "motion_render") && request.preview
    && typeof request.preview === "object" && !Array.isArray(request.preview)
    ? request.preview as Record<string, unknown> : null;
  const creativePacket = creativePreview?.exact_package && typeof creativePreview.exact_package === "object"
    && !Array.isArray(creativePreview.exact_package)
    ? creativePreview.exact_package as Record<string, unknown> : null;
  const creativeSource = creativePacket?.asset ?? creativePreview?.asset
    ?? (request.source_kind === "motion_render" ? {
      render_path: creativePreview?.render_path,
      file_sha256: creativePreview?.render_sha256,
    } : null);
  const creativeAsset = creativeSource && typeof creativeSource === "object"
    && !Array.isArray(creativeSource)
    ? creativeSource as Record<string, unknown> : null;
  const creativePath = creativeAsset && (request.source_kind === "video_seat"
    || request.source_kind === "motion_render"
    ? creativeAsset.render_path : creativeAsset.storage_path);
  const creativeDownloadable = !!creativeAsset
    && typeof creativePath === "string" && !!creativePath
    && typeof creativeAsset.file_sha256 === "string";
  const canReject = !salesManagerCard && isRejectionReady(request, clientId);
  const canApprove = !salesManagerCard && isApprovalReady(request, clientId);
  const canRevoke = !manager && isGatewayToolRevocable(request, clientId);
  const decisionLabel = request.source_kind === "google_review_reply"
    ? "Google review reply" : request.source_kind === "recruitment_brief"
      ? "Recruitment brief" : request.source_kind === "client_sales_entitlement"
        ? "Sales access" : request.source_kind === "campaign_preparation_package"
        ? "Campaign preparation package" : request.source_kind === "paid_operator_bundle"
          ? "Paid operator bundle" : request.source_kind === "google_search_copy"
          ? "Google search copy" : request.source_kind === "google_operator_bundle"
          ? "Google manual operator bundle" : request.source_kind === "service_offer"
          ? "Service offer" : request.source_kind === "lead_magnet"
            ? "Lead magnet" : request.source_kind === "sales_agent_public_use"
              ? "Sales agent public use" : request.source_kind === "opportunity_approve"
                ? "Market opportunity" : request.source_kind === "proof_rights"
                  ? "Proof usage rights" : request.source_kind === "proof_placement"
                    ? "Proof placement" : request.source_kind === "global_engine_activation"
                    ? "System Engine activation" : request.source_kind === "global_video_owner"
                      ? "Global video owner" : request.source_kind === "creative_requirement"
                      ? "Creative authority" : request.source_kind === "client_authority_assignment"
                      ? "Client approval seat" : request.source_kind === "gateway_tool"
                      ? "Gateway tool" : request.source_kind === "metrics_backfill"
                        ? "Metrics backfill" : request.source_kind === "integration_grant"
                      ? "Integration access" : request.source_kind === "activation_switch"
                      ? "Automation activation" : request.source_kind === "campaign_idea"
                      ? "Idea selection" : request.source_kind === "motion_render"
                      ? "Motion render" : request.source_kind === "video_seat"
                      ? "Video seat" : request.source_kind === "nurture_sequence"
                      ? "Nurture sequence" : request.source_kind === "message_template"
                      ? "Message template" : request.source_kind === "proof_artifact"
                      ? "Proof artifact" : request.source_kind === "ordinary_media"
                        ? "Creative source" : request.source_kind === "engine_slot"
                          ? "Engine slot" : "Campaign action";
  const magnetPreview = request.source_kind === "lead_magnet" && request.preview
    && typeof request.preview === "object" && !Array.isArray(request.preview)
    ? request.preview as Record<string, unknown> : null;
  const magnetDownloadable = magnetPreview
    && typeof magnetPreview.storage_path === "string"
    && typeof magnetPreview.content_sha256 === "string"
    && typeof magnetPreview.file_bytes === "number";

  return (
    <article className="rounded-xl border border-border bg-card p-5" aria-labelledby={`approval-${request.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`approval-${request.id}`} className="text-base font-semibold">{request.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {request.source_system} · {request.source_kind.replaceAll("_", " ")}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(request.status)}`}>
          {request.status.replaceAll("_", " ")}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Client</dt><dd className="break-all">{request.client_id || "Agency-wide"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Requested</dt><dd>{dateLabel(request.requested_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Request origin</dt><dd className="break-all">
          {request.requester_kind === "human"
            ? `Human ${request.requested_by || "unidentified"}`
            : `${request.requester_kind}${request.requester_ref ? ` · ${request.requester_ref}` : ""}`}
        </dd></div>
        <div><dt className="text-xs text-muted-foreground">Expires</dt><dd>{dateLabel(request.expires_at)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Decision owner</dt><dd>{request.owner_role || "Not assigned"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Destination</dt><dd className="break-all">{request.destination || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Account</dt><dd className="break-all">{request.account_ref || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Source version</dt><dd className="break-all font-mono text-xs">{request.source_version || "Not supplied"}</dd></div>
        {request.source_state && <div><dt className="text-xs text-muted-foreground">Live source state</dt>
          <dd>{request.source_state.replaceAll("_", " ")}</dd></div>}
        <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Exact artifact hash</dt><dd className="break-all font-mono text-xs">{request.artifact_hash || "Not supplied"}</dd></div>
      </dl>

      {salesGrant && <p role="status" className="mt-4 text-xs text-muted-foreground">
        Approving this grant records an entitlement for the exact client, team member and employee account above. It becomes active when system-wide sales access is enabled. Before enabling access, audit every approved, unrevoked grant.
      </p>}

      {blocker ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Incomplete preview: {blocker} This request is not decision-ready.
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Exact-version snapshot recorded. Decisions use the owning source's approval function.</p>
      )}
      {request.source_state && request.source_state !== "pending"
        && request.status !== "approved" && request.status !== "rejected"
        && request.status !== "revoked" && <p role="alert" className="mt-3 text-sm text-destructive">
          The owning source is {request.source_state.replaceAll("_", " ")}. {canReject
            ? "Approval is unavailable; this request can only be closed with a reasoned rejection."
            : "This card cannot be decided."}
        </p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="text-sm font-medium">Exact-version preview</h4>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.preview)}</pre>
        </div>
        <div className="space-y-4">
          <div><h4 className="text-sm font-medium">Approved scope</h4>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.scope)}</pre>
          </div>
          <div><h4 className="text-sm font-medium">Budget</h4>
            <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{printable(request.budget)}</pre>
          </div>
        </div>
      </div>

      {magnetDownloadable && <div className="mt-4">
        <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm"
          onClick={() => void downloadVerifiedMagnetFile(
            magnetPreview.storage_path as string,
            magnetPreview.content_sha256 as string,
            magnetPreview.file_bytes as number,
          ).then(() => { setDownloadedMagnetHash(request.artifact_hash); setDownloadError(null); })
            .catch((cause: unknown) => setDownloadError(
              cause instanceof Error ? cause.message : "Could not verify the file."))}>
          Download and verify exact file
        </button>
        {downloadedMagnetHash === request.artifact_hash && <p role="status" className="mt-2 text-xs">
          The downloaded file matched the bytes and hash on this card. Review its content before approval.
        </p>}
        {downloadError && <p role="alert" className="mt-2 text-xs text-destructive">{downloadError}</p>}
      </div>}

      {proofMediaDownloadable && <div className="mt-4">
        <p className="mb-2 text-xs text-muted-foreground">Download and inspect the verified file to unlock approval.</p>
        <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm"
          onClick={() => void downloadVerifiedProofFile(
            proofRightsPreview.verified_storage_path as string,
            proofRightsPreview.verified_storage_sha256 as string,
            proofRightsPreview.verified_file_bytes as number,
          ).then(() => { setDownloadedProofHash(`${request.id}:${request.artifact_hash}`); setDownloadError(null); })
            .catch((cause: unknown) => setDownloadError(
              cause instanceof Error ? cause.message : "Could not verify the proof file."))}>
          Download and verify proof file
        </button>
        {downloadedProofHash === `${request.id}:${request.artifact_hash}` && <p role="status" className="mt-2 text-xs">
          The downloaded proof matched the bytes and hash on this card. Review its content before approval.
        </p>}
        {downloadError && <p role="alert" className="mt-2 text-xs text-destructive">{downloadError}</p>}
      </div>}

      {creativeDownloadable && <div className="mt-4">
        <p className="mb-2 text-xs text-muted-foreground">Download and inspect the exact creative file to unlock approval.</p>
        <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm"
          onClick={() => void downloadVerifiedCreativeFile(
            creativePath as string,
            creativeAsset.file_sha256 as string,
          ).then(() => { setDownloadedCreativeHash(`${request.id}:${request.artifact_hash}`); setDownloadError(null); })
            .catch((cause: unknown) => setDownloadError(
              cause instanceof Error ? cause.message : "Could not verify the creative file."))}>
          Download and verify creative file
        </button>
        {downloadedCreativeHash === `${request.id}:${request.artifact_hash}` && <p role="status" className="mt-2 text-xs">
          The downloaded creative matched the byte hash on this card. Review its content before approval.
        </p>}
        {downloadError && <p role="alert" className="mt-2 text-xs text-destructive">{downloadError}</p>}
      </div>}

      {html && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium">Visual page preview</summary>
          <p className="mt-2 text-xs text-muted-foreground">Scripts, forms and external resources are disabled.</p>
          <iframe title={`Preview of ${request.title}`} sandbox="" referrerPolicy="no-referrer"
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">${html}`}
            className="mt-2 h-80 w-full rounded-lg border border-border bg-white" />
        </details>
      )}

      <details className="mt-4 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Decision history ({history.length})</summary>
        {history.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No decision has been recorded for this request.</p> : (
          <ol className="mt-3 space-y-3">
            {history.map((event, index) => (
              <li key={event.event_order ?? `${event.decided_at}-${index}`} className="border-t border-border pt-2 text-xs">
                <p className="font-medium">{event.decision.replaceAll("_", " ")} · {dateLabel(event.decided_at)}</p>
                <p className="mt-1 text-muted-foreground">Human: {event.actor_id || "Not recorded"} · Assurance: {event.actor_aal || "Not recorded"}</p>
                {event.reason && <p className="mt-1 whitespace-pre-wrap">Reason: {event.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </details>

      {request.source_kind === "gateway_tool" && <div className="mt-4 rounded-lg border border-border p-3 text-sm">
        <p className="font-medium">Gateway execution outcome</p>
        <p>Status: {gatewayOutcome?.execution_status ?? "Unavailable"}</p>
        {gatewayOutcome?.claimed_at && <p>Claimed: {dateLabel(gatewayOutcome.claimed_at)}</p>}
        {gatewayOutcome?.finished_at && <p>Finished: {dateLabel(gatewayOutcome.finished_at)}</p>}
        {gatewayOutcome?.sites_invoked_at && <p>Sites adapter started: {dateLabel(gatewayOutcome.sites_invoked_at)}</p>}
        {gatewayOutcome?.result_hash && <p className="break-all">Gateway result digest: {gatewayOutcome.result_hash}</p>}
        <p className="mt-1 text-xs text-muted-foreground">This gateway outcome is not an external provider receipt.</p>
      </div>}

      {shouldShowExecutionEvidence(request) && (
        <div className="mt-4 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">Execution evidence</p>
          <p>Recorded state: {executionEvidence?.state ?? "unknown"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {executionEvidence?.detail ?? "The execution ledger has not been read."}
          </p>
          {executionEvidence?.externalRef && <p className="mt-1 break-all text-xs">
            External reference: {executionEvidence.externalRef}
          </p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Approval and execution are separate. Inspect the owning source for the full attempt and provider receipt.
          </p>
        </div>
      )}

      {(canApprove || canReject || canRevoke) && (
        <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">{decisionLabel} decision</p>
          <p className="text-xs text-muted-foreground">
            This calls the source owner for the exact version above. AAL2 is required;
            the source and database recheck the request before recording a decision.
          </p>
          {!canApprove && canReject && <p className="text-xs text-muted-foreground">
            This request cannot be approved. It can only be closed with a reasoned rejection.
          </p>}
          {aal !== "aal2" && <p role="status" className="text-sm text-destructive">
            {aal === "aal1" ? "Complete MFA to reach AAL2 before deciding." : "MFA level could not be verified; decisions are unavailable."}{" "}
            <Link to="/security/mfa" state={{ returnTo: `${location.pathname}${location.search}` }} className="underline">Open account security</Link>
          </p>}
          <div className="flex flex-wrap gap-2">
            {canApprove && <button type="button" disabled={busy || aal !== "aal2"
              || (request.source_kind === "lead_magnet" && downloadedMagnetHash !== request.artifact_hash)
              || (proofMediaDownloadable && downloadedProofHash !== `${request.id}:${request.artifact_hash}`)
              || (creativeDownloadable && downloadedCreativeHash !== `${request.id}:${request.artifact_hash}`)}
              onClick={() => void onDecide(request, "approved")}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              Approve exact version
            </button>}
          {(canReject || canRevoke) && <label className="min-w-48 flex-1 text-sm">{canRevoke ? "Reason to revoke" : "Reason to reject"}
              <input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)}
                disabled={busy || aal !== "aal2"} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            </label>}
            {canReject && <button type="button" disabled={busy || aal !== "aal2" || !rejectionReason.trim()}
              onClick={() => void onDecide(request, "rejected", rejectionReason.trim())}
              className="self-end rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
              Reject with reason
            </button>}
            {canRevoke && <button type="button" disabled={busy || aal !== "aal2" || !rejectionReason.trim()}
              onClick={() => void onDecide(request, "revoked", rejectionReason.trim())}
              className="self-end rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
              Revoke with reason
            </button>}
          </div>
        </div>
      )}

      <div className="mt-4">
        {sourcePath ? (
          <>
            <Link className="text-sm font-medium text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={sourcePath}>{request.source_kind === "client_sales_entitlement"
                ? "Open sales access requests" : "View owning source"}</Link>
          </>
        ) : <span className="text-xs text-muted-foreground">
          {manager ? "Owning source is unavailable from the manager console." : "Owning source link unavailable."}
        </span>}
      </div>
    </article>
  );
}

export function UnifiedApprovalInboxPanel({ scope = "client" }: { scope?: "client" | "global" | "manager" }) {
  const { clientId } = useParams<{ clientId: string }>();
  const location = useLocation();
  const global = scope === "global";
  const manager = scope === "manager";
  const multiClient = global || manager;
  const scopeKey = multiClient ? scope : clientId ?? null;
  const initialSource = new URLSearchParams(location.search).get("source");
  const [requests, setRequests] = useState<UnifiedApprovalRequest[]>([]);
  const [decisions, setDecisions] = useState<UnifiedApprovalDecision[]>([]);
  const [gatewayOutcomes, setGatewayOutcomes] = useState<Record<string, GatewayOutcome>>({});
  const [executionEvidence, setExecutionEvidence] = useState<Map<string, ApprovalExecutionEvidence>>(new Map());
  const [statusFilter, setStatusFilter] = useState(initialSource ? "all" : "pending");
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [clientFilterDraft, setClientFilterDraft] = useState("");
  const [kindFilterDraft, setKindFilterDraft] = useState("");
  const [search, setSearch] = useState(initialSource ?? "");
  const [sourceDeepLink, setSourceDeepLink] = useState(initialSource);
  const [pageState, setPageState] = useState({ scopeKey, page: 0 });
  const page = pageState.scopeKey === scopeKey ? pageState.page : 0;
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedClientId, setLoadedClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [aal, setAal] = useState<"aal2" | "aal1" | "unavailable">("unavailable");
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!multiClient && !clientId) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      let query = supabase.from("approval_inbox_v6").select("*");
      if (!multiClient) query = query.eq("client_id", clientId!);
      else if (manager) query = query.eq("owner_role", "admin_or_active_client_manager");
      else if (clientFilter === "agency-wide") query = query.is("client_id", null);
      else if (clientFilter !== null) query = query.eq("client_id", clientFilter);
      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (kindFilter !== null) query = query.eq("source_kind", kindFilter);
      if (sourceDeepLink) query = query.eq("source_id", sourceDeepLink);
      // Fetch one sentinel row so the next-page control is based on evidence.
      // Each history query is then bounded to the 50 cards actually displayed.
      const requestResult = await query.order("requested_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      if (requestResult.error) throw requestResult.error;
      const pageRows = (requestResult.data ?? []).map(validatedRequest);
      const rows = pageRows.slice(0, PAGE_SIZE);
      const ids = rows.map((row) => row.id);
      let decisionRows: UnifiedApprovalDecision[] = [];
      if (ids.length > 0) {
        const decisionResult = await supabase.from("approval_decision_events_v6")
          .select("request_id,decision,actor_id,actor_aal,reason,decided_at,event_order")
          .in("request_id", ids).order("event_order", { ascending: false });
        if (decisionResult.error) throw decisionResult.error;
        decisionRows = decisionResult.data ?? [];
      }
      const gatewayIds = rows.filter((row) => row.source_kind === "gateway_tool"
        && row.source_id !== null).map((row) => row.source_id as string);
      const outcomeMap: Record<string, GatewayOutcome> = {};
      if (gatewayIds.length > 0) {
        const gatewayResult = await supabase.from("gateway_tool_execution_overview_v6")
          .select("approval_id,execution_status,claimed_at,finished_at,result_hash,sites_invocation_id,sites_invoked_at")
          .in("approval_id", gatewayIds).order("approval_id");
        if (gatewayResult.error) throw gatewayResult.error;
        for (const outcome of gatewayResult.data ?? []) {
          if (outcome.approval_id && gatewayIds.includes(outcome.approval_id))
            outcomeMap[outcome.approval_id] = outcome as GatewayOutcome;
        }
      }
      const executionMap = await loadApprovalExecutionEvidence(rows);
      if (sequence !== refreshSequence.current) return;
      try {
        const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (sequence !== refreshSequence.current) return;
        setAal(assurance.error ? "unavailable"
          : assurance.data.currentLevel === "aal2" ? "aal2" : "aal1");
      } catch {
        setAal("unavailable");
      }
      setRequests(rows);
      setDecisions(decisionRows);
      setGatewayOutcomes(outcomeMap);
      setExecutionEvidence(executionMap);
      setHasNextPage(pageRows.length > PAGE_SIZE);
      setError(null);
    } catch (cause) {
      if (sequence === refreshSequence.current) {
        setError(cause instanceof Error ? cause.message : (cause as { message?: string }).message ?? "Could not load the unified approval inbox.");
      }
    } finally {
      if (sequence === refreshSequence.current) {
        setLoadedClientId(scopeKey);
        setLoading(false);
      }
    }
  }, [clientId, clientFilter, kindFilter, manager, multiClient, page, scopeKey, sourceDeepLink, statusFilter]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; };
  }, [refresh]);

  function retry() {
    setLoading(true);
    setError(null);
    void refresh();
  }

  async function decide(request: UnifiedApprovalRequest, decision: "approved" | "rejected" | "revoked", reason?: string) {
    const targetClientId = multiClient ? request.client_id : clientId;
    const agencyWide = multiClient && !manager && request.client_id === null
      && ["global_engine_activation", "global_video_owner"].includes(request.source_kind);
    const scopeId = targetClientId ?? "";
    if ((!targetClientId && !agencyWide)
      || (manager && request.source_kind === "client_sales_entitlement")
      || (!agencyWide && request.client_id !== targetClientId)
      || (decision === "approved" ? !isApprovalReady(request, scopeId)
        : decision === "revoked" ? !isGatewayToolRevocable(request, scopeId)
          : !isRejectionReady(request, scopeId))) return;
    setBusyId(request.id);
    setDecisionError(null);
    try {
      const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance.error || assurance.data.currentLevel !== "aal2") {
        setAal(assurance.error ? "unavailable" : "aal1");
        throw new Error("Complete MFA to reach AAL2 before deciding this request.");
      }
      setAal("aal2");

      const currentQuery = supabase.from("approval_inbox_v6").select("*").eq("id", request.id);
      const current = await (agencyWide
        ? currentQuery.is("client_id", null).maybeSingle()
        : currentQuery.eq("client_id", targetClientId!).maybeSingle());
      if (current.error) throw current.error;
      const currentRequest = current.data ? validatedRequest(current.data) : null;
      if (!currentRequest || (decision === "approved" ? !isApprovalReady(currentRequest, scopeId)
        : decision === "revoked" ? !isGatewayToolRevocable(currentRequest, scopeId)
          : !isRejectionReady(currentRequest, scopeId))
        || !sameVersion(request, currentRequest)) {
        throw new Error(decision === "revoked"
          ? "This exact request changed or is no longer eligible. Review the refreshed card before deciding."
          : "This exact request changed or is no longer pending. Review the refreshed card before deciding.");
      }
      if (decision !== "approved" && !reason?.trim()) {
        throw new Error(`Enter a reason before ${decision === "revoked" ? "revoking" : "rejecting"} this request.`);
      }
      const outcome = request.source_kind === "google_review_reply"
        ? await supabase.rpc("decide_google_review_reply_from_inbox_v6", {
          p_reply_id: request.source_id,
          p_expected_source_version: request.source_version,
          p_expected_artifact_hash: request.artifact_hash!,
          p_approved: decision === "approved",
          ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
        })
        : request.source_kind === "recruitment_brief"
          ? await supabase.rpc("approve_recruitment_brief_from_inbox_v6", {
            p_brief_id: request.source_id,
            p_request_id: request.id,
            p_expected_source_version: request.source_version,
            p_expected_artifact_hash: request.artifact_hash!,
          })
        : request.source_kind === "client_sales_entitlement"
          ? await supabase.rpc("decide_client_sales_entitlement", {
            p_request_id: request.source_id,
            p_scope_hash: request.source_version,
            p_approve: decision === "approved",
            p_note: decision === "rejected" ? reason!.trim() : "Approved from unified Approval Inbox",
          })
        : request.source_kind === "campaign_preparation_package"
          ? await supabase.rpc("decide_campaign_preparation_package_v7", {
            p_package_id: request.source_id, p_request_id: request.id,
            p_approved: decision === "approved",
            ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
          })
        : request.source_kind === "paid_operator_bundle"
          ? await supabase.rpc("decide_paid_operator_bundle_v7", {
            p_bundle_id: request.source_id, p_request_id: request.id,
            p_approved: decision === "approved",
            ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
          })
        : request.source_kind === "google_operator_bundle"
          ? await supabase.rpc("decide_google_operator_bundle_v7", {
            p_bundle_id: request.source_id, p_request_id: request.id,
            p_approved: decision === "approved",
            ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
          })
        : request.source_kind === "google_search_copy"
          ? await supabase.rpc("decide_google_search_copy_v7", {
            p_copy_id: request.source_id, p_request_id: request.id,
            p_approved: decision === "approved",
            ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
          })
        : request.source_kind === "service_offer"
          ? decision === "approved"
            ? await supabase.rpc("approve_service_offer_version_v6", { p_version_id: request.source_id })
            : await supabase.rpc("reject_service_offer_version_v6", {
              p_version_id: request.source_id, p_reason: reason!.trim(),
            })
        : request.source_kind === "lead_magnet"
          ? await supabase.rpc("decide_lead_magnet_approval_v6", {
            p_approval_id: request.source_id,
            p_approved: decision === "approved",
            ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
          })
        : request.source_kind === "sales_agent_public_use"
          ? decision === "approved"
            ? await supabase.rpc("approve_sales_agent_public_use_v6", {
              p_agent_id: request.source_id, p_request_id: request.id,
            })
            : await supabase.rpc("reject_sales_agent_public_use_v6", {
              p_agent_id: request.source_id, p_request_id: request.id,
              p_reason: reason!.trim(),
            })
        : request.source_kind === "opportunity_approve"
          ? decision === "approved"
            ? await supabase.rpc("approve_opportunity_v6", {
              p_opportunity_id: request.source_id, p_request_id: request.id,
            })
            : await supabase.rpc("reject_opportunity_approval_v6", {
              p_opportunity_id: request.source_id, p_request_id: request.id,
              p_reason: reason!.trim(),
            })
        : request.source_kind === "proof_rights"
          ? decision === "approved"
            ? await supabase.rpc("approve_proof_rights_v6", {
              p_rights_request_id: request.source_id, p_canonical_id: request.id,
            })
            : await supabase.rpc("reject_proof_rights_v6", {
              p_rights_request_id: request.source_id, p_canonical_id: request.id,
              p_reason: reason!.trim(),
            })
        : request.source_kind === "proof_placement"
          ? await supabase.rpc("decide_proof_placement_inbox_v6", {
              p_approval_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "proof_artifact"
          ? decision === "approved"
            ? await supabase.rpc("approve_proof_artifact_inbox_v6", {
                p_review_id: request.source_id, p_request_id: request.id,
              })
            : await supabase.rpc("reject_proof_artifact_inbox_v6", {
                p_review_id: request.source_id, p_request_id: request.id,
                p_reason: reason!.trim(),
              })
        : request.source_kind === "ordinary_media"
          ? decision === "approved"
            ? await supabase.rpc("approve_ordinary_media_inbox_v6", {
                p_review_id: request.source_id, p_request_id: request.id,
              })
            : await supabase.rpc("reject_ordinary_media_inbox_v6", {
                p_review_id: request.source_id, p_request_id: request.id,
                p_reason: reason!.trim(),
              })
        : request.source_kind === "proof_delivery"
          ? await supabase.rpc("decide_proof_delivery_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "meta_profile_change"
          ? await supabase.rpc("decide_meta_profile_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "google_profile_change"
          ? await supabase.rpc("decide_google_profile_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "opportunity_activate"
          ? await supabase.rpc("decide_opportunity_activation_inbox_v6", {
              p_activation_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "message_template"
          ? await supabase.rpc("decide_message_template_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "nurture_sequence"
          ? await supabase.rpc("decide_nurture_sequence_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "global_engine_activation"
          ? await supabase.rpc("decide_global_engine_activation_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "global_video_owner"
          ? await supabase.rpc("decide_global_video_owner_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "integration_grant"
          ? await supabase.rpc("decide_integration_grant_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "metrics_backfill"
          ? await supabase.rpc("decide_metrics_backfill_review_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "creative_requirement"
          ? await supabase.rpc("decide_creative_requirement_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "client_authority_assignment"
          ? await supabase.rpc("decide_client_authority_assignment_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "gateway_tool"
          ? decision === "revoked" ? await supabase.rpc("revoke_gateway_tool_review_v6", {
              p_approval_id: request.source_id, p_request_id: request.id,
              p_reason: reason!.trim(),
            }) : await supabase.rpc("decide_gateway_tool_review_v6", {
              p_approval_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "activation_switch"
          ? await supabase.rpc("decide_client_switch_activation_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "campaign_idea"
          ? await supabase.rpc("decide_human_idea_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "motion_render"
          ? await supabase.rpc("decide_motion_render_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "video_seat"
          ? await supabase.rpc("decide_video_seat_inbox_v6", {
              p_review_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "engine_slot"
          ? await supabase.rpc("decide_engine_slot_inbox_v6", {
              p_slot_id: request.source_id, p_request_id: request.id,
              p_approved: decision === "approved",
              ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
            })
        : request.source_kind === "campaign_action"
          ? await supabase.rpc("decide_campaign_action_approval_v6", {
          p_request_id: request.source_id,
          p_decision: decision,
          ...(decision === "rejected" ? { p_reason: reason!.trim() } : {}),
        }) : null;
      if (!outcome) throw new Error("This request has no supported source decision function.");
      if (outcome.error) throw outcome.error;
      setStatusFilter("all");
      await refresh();
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message
        : (cause as { message?: string }).message ?? "The decision could not be recorded.");
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  const waiting = loading || loadedClientId !== scopeKey;

  const kinds = useMemo(() => [...new Set([
    ...RELEASED_SOURCE_KINDS,
    ...requests.map((request) => request.source_kind),
    ...(kindFilter === null ? [] : [kindFilter]),
  ])].sort(), [requests, kindFilter]);
  const clients = useMemo(() => [...new Set([
    ...requests.map((request) => request.client_id ?? "agency-wide"),
    ...(clientFilter === null ? [] : [clientFilter]),
  ])].sort(), [requests, clientFilter]);

  function applyExactFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientFilter(clientFilterDraft.trim() || null);
    setKindFilter(kindFilterDraft.trim() || null);
    setSourceDeepLink(null);
    setSearch("");
    setPageState({ scopeKey, page: 0 });
  }
  const visible = useMemo(() => requests.filter((request) => {
    const needle = search.trim().toLocaleLowerCase();
    return !needle || [request.title, request.source_id, request.source_system, request.source_kind,
      request.destination, request.account_ref].some((part) => part?.toLocaleLowerCase().includes(needle));
  }), [requests, search]);

  const historyByRequest = useMemo(() => {
    const grouped = new Map<string, UnifiedApprovalDecision[]>();
    for (const decision of decisions) {
      const group = grouped.get(decision.request_id) ?? [];
      group.push(decision);
      grouped.set(decision.request_id, group);
    }
    return grouped;
  }, [decisions]);

  return (
    <section className="space-y-5" aria-labelledby="unified-approvals-title">
      <div>
        <h2 id="unified-approvals-title" className="text-xl font-semibold">
          {global ? "Agency approval inbox" : manager ? "Manager approval inbox" : "Unified approval inbox"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {global ? "Canonical requests across every client and the agency house client appear here. "
            : manager ? "Canonical requests for clients currently assigned to you appear here. "
              : "Canonical requests and decision history appear here as source adapters are connected. "}
          {manager
            ? "Complete campaign action, Google review reply and service offer requests can be decided here through their owning functions."
            : "Complete campaign action, Google review reply, recruitment brief, sales access and service offer requests can be decided here through their owning functions."}
          {manager ? " Other requests remain read-only. " : " Other requests link to their owning source. "}
          Coverage is incomplete: work not yet mirrored here remains in its owning queue.
          Pending here reflects the canonical ledger; each owning source is checked again before a decision.
        </p>
      </div>

      {global && <ApprovalCoveragePanel />}
      <ExternalExecutionAlerts clientId={multiClient ? undefined : clientId} />
      <HeldExternalJobs clientId={multiClient ? undefined : clientId} />

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-4">
        <label className="min-w-40 flex-1 text-sm font-medium">Status
          <select value={statusFilter} onChange={(event) => {
            setStatusFilter(event.target.value); setPageState({ scopeKey, page: 0 });
          }}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="expired">Expired</option>
            <option value="stale">Stale source</option>
            <option value="revoked">Revoked</option><option value="superseded">Superseded</option>
            <option value="cancelled">Cancelled</option><option value="source_held">Source held</option>
            <option value="source_decided">Source decided without a mirrored event</option>
            <option value="unverified">Source unverified</option>
            <option value="all">All statuses</option>
          </select>
        </label>
        <form onSubmit={applyExactFilters} aria-label="Exact approval filters"
          className="flex min-w-full flex-wrap items-end gap-3">
          {global && <label className="min-w-48 flex-1 text-sm font-medium">Client ID
            <input value={clientFilterDraft} onChange={(event) => setClientFilterDraft(event.target.value)}
              list="approval-client-suggestions" placeholder="Any client ID, or agency-wide"
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            <datalist id="approval-client-suggestions">
              {clients.map((id) => <option key={id} value={id} />)}
            </datalist>
          </label>}
          <label className="min-w-48 flex-1 text-sm font-medium">Source type
            <input value={kindFilterDraft} onChange={(event) => setKindFilterDraft(event.target.value)}
              list="approval-kind-suggestions" placeholder="Any exact source kind"
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            <datalist id="approval-kind-suggestions">
              {kinds.map((kind) => <option key={kind} value={kind} />)}
            </datalist>
          </label>
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm font-medium">
            Apply filters
          </button>
          <p className="min-w-full text-xs text-muted-foreground">
            Exact filters search every request page. Suggestions are shortcuts; enter any client ID or source kind. Leave a field blank for all. Use agency-wide for requests without a client.
          </p>
          {(clientFilter !== null || kindFilter !== null) && <p role="status" className="min-w-full text-xs text-muted-foreground">
            Applied: client {clientFilter === null ? "any" : clientFilter}; source {kindFilter === null ? "any" : kindFilter}.
          </p>}
        </form>
        <label className="min-w-48 flex-[2] text-sm font-medium">Search current page
          <input type="search" value={search} onChange={(event) => {
            setSearch(event.target.value); setSourceDeepLink(null);
            setPageState({ scopeKey, page: 0 });
          }}
            placeholder="Title, source, destination or account"
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
      </div>

      {!multiClient && !clientId && <p role="alert" className="text-sm text-destructive">Select a client to view approvals.</p>}
      {error && !waiting && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{error}</p><button type="button" onClick={retry} className="mt-2 underline">Retry</button>
      </div>}
      {decisionError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{decisionError}</p>}
      {scopeKey && waiting ? <p role="status" className="text-sm text-muted-foreground">Loading canonical requests…</p>
        : error ? null
          : scopeKey ? <>
            <p className="text-sm text-muted-foreground">
              Page {page + 1}: showing {visible.length} of {requests.length} loaded requests.
              {search.trim() ? " Search applies to this page." : ""}
            </p>
            {visible.length === 0 ? <p className="text-sm text-muted-foreground">
              {requests.length === 0 ? page === 0
                ? "No requests have been mirrored yet or match these filters. Check the existing queue tabs for outstanding work."
                : "No requests on this page. Return to the previous page."
                : "No requests match these filters."}
            </p> : <div className="space-y-4">{visible.map((request) => (
              <RequestCard key={request.id} request={request} history={historyByRequest.get(request.id) ?? []}
                gatewayOutcome={gatewayOutcomes[request.source_id]}
                executionEvidence={executionEvidence.get(request.id)}
                clientId={multiClient ? request.client_id ?? "" : clientId ?? ""}
                manager={manager}
                aal={aal} busy={busyId === request.id} onDecide={decide} />
            ))}</div>}
            {(page > 0 || hasNextPage) && <nav aria-label="Approval pages" className="flex items-center gap-3">
              <button type="button" disabled={page === 0 || waiting}
                onClick={() => setPageState({ scopeKey, page: page - 1 })}
                className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Previous page</button>
              <span className="text-sm text-muted-foreground">Page {page + 1}</span>
              <button type="button" disabled={!hasNextPage || waiting}
                onClick={() => setPageState({ scopeKey, page: page + 1 })}
                className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Next page</button>
            </nav>}
          </> : null}
    </section>
  );
}
