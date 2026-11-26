import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, getAAL, downloadVerifiedProofFile, downloadVerifiedCreativeFile, loadCreativeReviewIntake, requestOrdinaryMediaReview } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), getAAL: vi.fn(), downloadVerifiedProofFile: vi.fn(),
  downloadVerifiedCreativeFile: vi.fn(), loadCreativeReviewIntake: vi.fn(), requestOrdinaryMediaReview: vi.fn(),
}));
vi.mock("../../lib/proofRights", () => ({ downloadVerifiedProofFile }));
vi.mock("../../lib/creativeReview", () => ({ downloadVerifiedCreativeFile, requestOrdinaryMediaReview }));
vi.mock("./creativeReviewIntake", () => ({ loadCreativeReviewIntake }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from, rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: getAAL } },
} }));
vi.mock("./ApprovalCoveragePanel", () => ({ ApprovalCoveragePanel: () => null }));
vi.mock("./ExternalExecutionAlerts", () => ({ ExternalExecutionAlerts: () => null }));
vi.mock("./HeldExternalJobs", () => ({ HeldExternalJobs: () => null }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

import { UnifiedApprovalInboxPanel } from "./UnifiedApprovalInboxPanel";

const request = {
  id: "request-1",
  client_id: "client-1",
  source_system: "console",
  source_kind: "campaign_action",
  source_id: "action-1",
  source_version: "v3",
  title: "Build the Meta ad",
  status: "pending",
  requested_at: "2026-10-30T08:00:00Z",
  requested_by: null,
  requester_kind: "service",
  requester_ref: "campaign_action_approvals:source-1",
  expires_at: "2026-10-31T08:00:00Z",
  artifact_hash: "a".repeat(64),
  preview: { headline: "Exact headline", body: "Exact offer body" },
  destination: "meta:act_123",
  account_ref: "act_123",
  budget: { daily_spend_limit: 50 },
  scope: { placement: "feed" },
  owner_role: "admin",
  preview_blocker: null,
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=campaign-actions",
};

let requests: unknown[];
let decisions: unknown[];
let gatewayOutcomes: unknown[];
let requestError: { message: string } | null;
let decisionError: { message: string } | null;
let freshRequest: unknown | undefined;
let clientEqValues: string[];
let requestRanges: Array<[number, number]>;
let historyIds: string[][];
let campaignDueRows: unknown[];
let proofOutcomeRows: unknown[];

const readyCampaign = {
  ...request, source_system: "aa_console", expires_at: "2030-01-01T00:00:00Z",
};

const readyGoogle = {
  ...request,
  id: "google-request-1", source_system: "aa_console", source_kind: "google_review_reply",
  source_id: "reply-1", source_version: "b".repeat(64), artifact_hash: "b".repeat(64),
  title: "Google review reply: Harbour Home", expires_at: "2030-01-01T00:00:00Z",
  preview: {
    reply_body: "Thanks for sharing your experience.", reply_body_sha256: "c".repeat(64),
    review_id: "review-1", review_ref: "review-remote-1",
    location_ref: "accounts/1184/locations/7730", location_title: "Harbour Home",
  },
  destination: "google_business:accounts/1184/locations/7730/reviews/review-remote-1/reply",
  account_ref: "accounts/1184/locations/7730", budget: null,
  scope: {
    client_id: "client-1", reply_id: "reply-1", review_id: "review-1",
    review_ref: "review-remote-1", location_ref: "accounts/1184/locations/7730",
    body_hash: "c".repeat(64),
  },
  owner_role: "admin_or_active_client_manager",
  owning_path: "/clients/client-1/google-profile?tab=reviews",
};

const readyRecruitment = {
  ...request,
  id: "recruitment-request-1", client_id: "client-1", source_system: "aa_console",
  source_kind: "recruitment_brief", source_id: "brief-1",
  source_version: `${"d".repeat(64)}:v1`, artifact_hash: "d".repeat(64),
  title: "Recruitment brief: Editor", expires_at: "2030-01-01T00:00:00Z",
  preview: {
    id: "brief-1", client_id: "client-1", purpose: "recruitment", media_type: "image",
    title: "Editor", hook: "Cut work that ships", script: "Join the editing team",
    call_to_action: "Apply now", apply_url: "https://attractacq.com/careers/editor",
    recruitment_role: "editor", compensation_text: "£250/day",
  },
  destination: "internal:recruitment_ad_generation", account_ref: null, budget: null,
  scope: { purpose: "recruitment", recruitment_role: "editor", media_type: "image",
    apply_url: "https://attractacq.com/careers/editor" },
  owner_role: "admin", owning_path: "/team?tab=recruitment",
};

const salesRequestId = "11111111-1111-4111-8111-111111111111";
const salesHash = "f".repeat(64);
const readySales = {
  ...request,
  id: "sales-inbox-1", source_system: "aa_console", source_kind: "client_sales_entitlement",
  source_id: salesRequestId, source_version: salesHash, artifact_hash: salesHash,
  title: "Grant sales access", source_state: "pending",
  requested_by: "admin-1", requester_kind: "human", requester_ref: null,
  expires_at: "2030-01-01T00:00:00Z",
  preview: {
    action: "grant", client_name: "Service Client", member_name: "Employee One",
    client_id: "client-1", member_id: "member-1", bound_user_id: "employee-1",
    permission: "Read and manage this client's leads and conversations",
  },
  destination: "client_sales_os:client-1", account_ref: "employee-1", budget: null,
  scope: {
    client_id: "client-1", member_id: "member-1", bound_user_id: "employee-1",
    action: "grant", scope_hash: salesHash,
  },
  owner_role: "admin", preview_blocker: null,
  owning_path: "/clients/client-1/delivery/sales-os?tab=leads",
};

const readySalesRevoke = {
  ...readySales, id: "sales-inbox-revoke", source_id: "22222222-2222-4222-8222-222222222222",
  title: "Revoke sales access", preview: { ...readySales.preview, action: "revoke" },
  scope: { ...readySales.scope, action: "revoke" },
};

const offerVersionId = "33333333-3333-4333-8333-333333333333";
const offerId = "44444444-4444-4444-8444-444444444444";
const offerHash = "e".repeat(64);
const readyOffer = {
  ...request, id: "offer-inbox-1", source_system: "aa_console", source_kind: "service_offer",
  source_id: offerVersionId, source_version: offerHash, artifact_hash: offerHash,
  title: "Service offer: Consulting · version 1", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", destination: "campaign_factory:offer_version",
  account_ref: null, budget: null, owner_role: "admin_or_active_client_manager",
  preview: { offer_id: offerId, offer_version_id: offerVersionId, client_id: "client-1",
    version: 1, service_name: "Consulting", audience: "Owners", promise: "Clear plan",
    inclusions: ["Workshop"], exclusions: ["No guarantee"], price_amount: 1000,
    currency: "EUR", delivery_cost_estimate: 200, claims: [] },
  scope: { client_id: "client-1", offer_id: offerId, offer_version_id: offerVersionId,
    version: 1, content_hash: offerHash },
  owning_path: `/clients/client-1/delivery/offer-studio?tab=versions&offer=${offerId}`,
};

const packageId = "99999999-9999-4999-8999-999999999999";
const packageHash = "9".repeat(64);
const readyPreparation = {
  ...request, id: "preparation-inbox-1", source_system: "aa_console",
  source_kind: "campaign_preparation_package", source_id: packageId,
  source_version: packageHash, artifact_hash: packageHash,
  title: "Campaign preparation package v1", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z",
  destination: "campaign_factory:prepared_package", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", campaign_id: "campaign-1", run_id: "run-1",
    routes: [{ route: "organic", version: 1 }],
    outputs: [{ item_key: "content_piece1", output_fingerprint: "a".repeat(64) }] },
  scope: { client_id: "client-1", campaign_id: "campaign-1", run_id: "run-1",
    package_id: packageId, snapshot_hash: packageHash, version: 1 },
  owning_path: "/clients/client-1/delivery/campaign-factory?campaign=campaign-1",
};

const googleBundleId = "88888888-8888-4888-8888-888888888888";
const googleBundleHash = "8".repeat(64);
const readyGoogleOperator = {
  ...request, id: "google-operator-inbox-1", source_system: "aa_console",
  source_kind: "google_operator_bundle", source_id: googleBundleId,
  source_version: googleBundleHash, artifact_hash: googleBundleHash,
  title: "Google manual operator bundle v1", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z",
  destination: "google_ads:manual_operator_handoff", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { source: { campaign_id: "campaign-1", sheet_id: "sheet-1" },
    owner: "Paid operator", headlines: ["One", "Two", "Three"],
    descriptions: ["First description", "Second description"] },
  scope: { client_id: "client-1", campaign_id: "campaign-1", sheet_id: "sheet-1",
    bundle_id: googleBundleId, snapshot_hash: googleBundleHash, version: 1 },
  owning_path: "/clients/client-1/delivery/google-ads-studio",
};

const paidBundleId = "77777777-7777-4777-8777-777777777777";
const paidBundleHash = "7".repeat(64);
const organicPackageId = "88888888-8888-4888-8888-888888888888";
const organicPackageHash = "8".repeat(64);
const readyOrganicPublication = {
  ...request, id: "organic-publication-inbox-1", source_system: "aa_console",
  source_kind: "organic_publication", source_id: organicPackageId,
  source_version: organicPackageHash, artifact_hash: organicPackageHash,
  title: "Organic publication: instagram", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", destination: "organic:instagram",
  account_ref: "ig-account-1", owner_role: "client_media_reviewer",
  preview: { client_id: "client-1", scheduled_post_id: "post-1", slot_id: "slot-1",
    platform: "instagram", account_ref: "ig-account-1",
    scheduled_at: "2026-11-20T12:00:00Z", rights: { usage_rights: "client_owned" },
    provider_copy: { caption: "Approved exact caption" },
    media: [{ frozen_bucket: "publication-media", sha256: "a".repeat(64) }] },
  scope: { client_id: "client-1", scheduled_post_id: "post-1", slot_id: "slot-1",
    source_snapshot_hash: "b".repeat(64) },
};
const readyPaidOperator = {
  ...request, id: "paid-operator-inbox-1", source_system: "aa_console",
  source_kind: "paid_operator_bundle", source_id: paidBundleId,
  source_version: paidBundleHash, artifact_hash: paidBundleHash,
  title: "Google paid operator bundle v1", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z",
  destination: "google_ads:manual_operator_handoff", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { source: { campaign_id: "campaign-1", package_id: packageId,
    platform: "google", creative: [{ copy_id: googleBundleId }] },
    operator: "Paid operator", budget_instruction: "Cap at 25 per day",
    tracking_instruction: "Record external campaign ID",
    research_task: "Research search terms, negatives and match types" },
  scope: { client_id: "client-1", campaign_id: "campaign-1", package_id: packageId,
    bundle_id: paidBundleId, platform: "google", snapshot_hash: paidBundleHash,
    version: 1 },
  owning_path: "/clients/client-1/delivery/google-ads-studio",
};

const googleCopyId = "99999999-9999-4999-8999-999999999999";
const googleCopyHash = "9".repeat(64);
const readyGoogleCopy = {
  ...request, id: "google-copy-inbox-1", source_system: "aa_console",
  source_kind: "google_search_copy", source_id: googleCopyId,
  source_version: googleCopyHash, artifact_hash: googleCopyHash,
  title: "Google search copy · piece 2", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z",
  destination: "google_ads:manual_operator_handoff", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { campaign_id: "campaign-1", route_package_id: "route-1",
    work_item_id: "work-1", copy_hash: googleCopyHash,
    headlines: ["One", "Two", "Three"],
    descriptions: ["First description", "Second description"],
    rationale: "The copy follows the approved offer and intended buyer." },
  scope: { client_id: "client-1", campaign_id: "campaign-1",
    route_package_id: "route-1", work_item_id: "work-1",
    copy_id: googleCopyId, copy_hash: googleCopyHash },
  owning_path: "/clients/client-1/delivery/campaign-factory?campaign=campaign-1",
};

const publicAgentId = "55555555-5555-4555-8555-555555555555";
const publicAgentToken = "66666666-6666-4666-8666-666666666666";
const publicAgentHash = "1".repeat(64);
const readyPublicAgent = {
  ...request, id: "public-agent-inbox-1", source_system: "aa_console",
  source_kind: "sales_agent_public_use", source_id: publicAgentId,
  source_version: `${publicAgentHash}:${publicAgentToken}`,
  artifact_hash: publicAgentHash, title: "Sales agent public use: Qualifier",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: `public_sales_agent:${publicAgentId}`, account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { agent_id: publicAgentId, client_id: "client-1",
    request_token: publicAgentToken, name: "Qualifier", status: "live",
    built_at: "2026-11-14T12:00:00Z", page_id: "page-1",
    greeting: "Hello", system_prompt: "Answer accurately", guardrails: "No guarantees",
    qualification: [], objections: [] },
  scope: { agent_id: publicAgentId, client_id: "client-1",
    request_token: publicAgentToken, page_id: "page-1",
    script_hash: publicAgentHash },
  owning_path: `/clients/client-1/delivery/sales-os?agent=${publicAgentId}`,
};

const opportunityId = "77777777-7777-4777-8777-777777777777";
const opportunityToken = "88888888-8888-4888-8888-888888888888";
const opportunityHash = "2".repeat(64);
const readyOpportunity = {
  ...request, id: "opportunity-inbox-1", source_system: "aa_console",
  source_kind: "opportunity_approve", source_id: opportunityId,
  source_version: `${opportunityHash}:${opportunityToken}`,
  artifact_hash: opportunityHash, title: "Approve market opportunity: Winter garage gym",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: `campaign_factory:opportunity:${opportunityId}`,
  account_ref: null, budget: null, owner_role: "admin_or_active_client_manager",
  preview: { opportunity_id: opportunityId, client_id: "client-1",
    request_token: opportunityToken,
    opportunity: { name: "Winter garage gym", micro_market: "Homeowners" },
    score: { total: 72, classification: "test" },
    attributes: [], awareness: [{ stage: "problem_aware", message: "Winter matters" }],
    links: [], proof_requirements: [] },
  scope: { opportunity_id: opportunityId, client_id: "client-1",
    request_token: opportunityToken, content_hash: opportunityHash },
  owning_path: `/clients/client-1/delivery/market-opportunities?opportunity=${opportunityId}`,
};

const proofRightsId = "99999999-9999-4999-8999-999999999999";
const proofId = "aaaa1111-aaaa-4111-8111-aaaaaaaa1111";
const proofToken = "bbbb1111-bbbb-4111-8111-bbbbbbbb1111";
const proofHash = "3".repeat(64);
const readyProofRights = {
  ...request, id: "proof-rights-inbox-1", source_system: "aa_console",
  source_kind: "proof_rights", source_id: proofRightsId,
  source_version: `${proofHash}:${proofToken}`,
  artifact_hash: proofHash, title: "Clear proof rights: Testimonial",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: `proof_bank:clear:${proofId}`, account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", proof_id: proofId, request_token: proofToken,
    requested_rights: "approved", permission_basis: "Customer signed release",
    expires_on: null, proof: { id: proofId, media_type: "text", storage_path: null,
      title: "Testimonial", body: "A customer result" } },
  scope: { client_id: "client-1", proof_id: proofId,
    rights_request_id: proofRightsId, request_token: proofToken,
    content_hash: proofHash, requested_rights: "approved" },
  owning_path: `/clients/client-1/delivery/proof-production-factory?proof=${proofId}`,
};

const placementApprovalId = "dddd1111-dddd-4111-8111-dddddddd1111";
const placementId = "eeee1111-eeee-4111-8111-eeeeeeee1111";
const placementToken = "ffff1111-ffff-4111-8111-ffffffff1111";
const placementHash = "4".repeat(64);
const readyProofPlacement = {
  ...request, id: "proof-placement-inbox-1", source_system: "aa_console",
  source_kind: "proof_placement", source_id: placementApprovalId,
  source_version: `${placementHash}:${placementToken}`,
  artifact_hash: placementHash, title: "Place proof at third_party_directory",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: `proof_distribution:third_party_directory:${placementId}`,
  account_ref: null, budget: null, owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", approval_id: placementApprovalId,
    placement_id: placementId, request_token: placementToken,
    destination_key: "third_party_directory", placement_payload_hash: "5".repeat(64),
    source_proof: { id: proofId, media_type: "text", storage_path: null,
      body: "Customer result", usage_rights: "approved" },
    payload_proof: { id: proofId, body: "Customer result" }, artifact: null, media: null },
  scope: { client_id: "client-1", approval_id: placementApprovalId,
    placement_id: placementId, request_token: placementToken,
    destination_key: "third_party_directory", content_hash: placementHash,
    effect: "release_for_placement" },
  owning_path: "/clients/client-1/delivery/proof-distribution?tab=placements",
};

const artifactReviewId = "12121212-1212-4212-8212-121212121212";
const artifactVersionId = "13131313-1313-4313-8313-131313131313";
const artifactToken = "14141414-1414-4414-8414-141414141414";
const artifactHash = "7".repeat(64);
const readyProofArtifact = {
  ...request, id: "proof-artifact-inbox-1", source_system: "aa_console",
  source_kind: "proof_artifact", source_id: artifactReviewId,
  source_version: `${artifactHash}:${artifactToken}`,
  artifact_hash: artifactHash, title: "Sign off proof artifact: local_proof_snippet v1",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: `proof_bank:artifact:${artifactVersionId}`, account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", artifact_version_id: artifactVersionId,
    request_token: artifactToken,
    artifact: { id: artifactVersionId, client_id: "client-1", source_proof_id: proofId,
      content: "Customer result with supported evidence", supported_claim: "Delivered on time",
      evidence_excerpt: "Signed handover" },
    source_proof: { id: proofId, client_id: "client-1", usage_rights: "approved",
      approved_rights_request_id: proofRightsId, body: "Customer result" } },
  scope: { client_id: "client-1", review_id: artifactReviewId,
    artifact_version_id: artifactVersionId, request_token: artifactToken,
    content_hash: artifactHash, effect: "source_and_claim_signoff" },
  owning_path: "/clients/client-1/delivery/proof-production-factory?tab=artifacts",
};

const mediaReviewId = "15151515-1515-4515-8515-151515151515";
const mediaAssetId = "16161616-1616-4616-8616-161616161616";
const mediaToken = "17171717-1717-4717-8717-171717171717";
const mediaHash = "8".repeat(64);
const mediaFileHash = "9".repeat(64);
const readyOrdinaryMedia = {
  ...request, id: "ordinary-media-inbox-1", source_system: "aa_console",
  source_kind: "ordinary_media", source_id: mediaReviewId,
  source_version: `${mediaHash}:${mediaToken}`, artifact_hash: mediaHash,
  title: "Review creative: Client image", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", destination: `creative_source:${mediaAssetId}`,
  account_ref: null, budget: null, owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", asset_id: mediaAssetId, request_token: mediaToken,
    asset: { id: mediaAssetId, client_id: "client-1", title: "Client image",
      media_type: "image", content_format: "single", storage_path: "client-1/image.png",
      file_sha256: mediaFileHash, usage_rights: "agency_owned" },
    storage: { bucket: "client-media", object_id: "storage-object-1", version: "v1" } },
  scope: { client_id: "client-1", asset_id: mediaAssetId, review_id: mediaReviewId,
    request_token: mediaToken, content_hash: mediaHash, effect: "creative_source_signoff" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=assets",
};

const proofDeliveryReviewId = "20202020-2020-4020-8020-202020202020";
const proofDeliveryToken = "21212121-2121-4121-8121-212121212121";
const proofDeliveryHash = "c".repeat(64);
const readyProofDelivery = {
  ...request, id: "proof-delivery-inbox-1", source_system: "aa_console",
  source_kind: "proof_delivery", source_id: proofDeliveryReviewId,
  source_version: `${proofDeliveryHash}:${proofDeliveryToken}`,
  artifact_hash: proofDeliveryHash, title: "Send proof request: email to customer",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: "email:customer@example.invalid", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", delivery_id: "delivery-1",
    request_token: proofDeliveryToken, config_id: "config-1", link_id: "link-1",
    channel: "email", recipient: "customer@example.invalid",
    sender_ref: "resend:Proof <proof@example.invalid>",
    subject: "Evidence request", message: "Please send evidence",
    capture_url: "https://example.invalid/capture/private" },
  scope: { client_id: "client-1", delivery_id: "delivery-1",
    review_id: proofDeliveryReviewId, request_token: proofDeliveryToken,
    content_hash: proofDeliveryHash, effect: "proof_request_send" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const metaProfileReviewId = "22222222-2222-4222-8222-222222222222";
const metaProfileToken = "23232323-2323-4232-8232-232323232323";
const metaProfileHash = "d".repeat(64);
const readyMetaProfileChange = {
  ...request, id: "meta-profile-inbox-1", source_system: "aa_console",
  source_kind: "meta_profile_change", source_id: metaProfileReviewId,
  source_version: `${metaProfileHash}:${metaProfileToken}`,
  artifact_hash: metaProfileHash, title: "Review instagram profile bio",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: "meta_profile:instagram:bio", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", change_id: "change-1", request_token: metaProfileToken,
    platform: "instagram", field: "bio", current_value: "Old bio",
    proposed_value: "New bio", consequence: "Proposal only" },
  scope: { client_id: "client-1", change_id: "change-1",
    review_id: metaProfileReviewId, request_token: metaProfileToken,
    content_hash: metaProfileHash, effect: "meta_profile_proposal_only" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const googleProfileReviewId = "24242424-2424-4242-8242-242424242424";
const googleProfileToken = "25252525-2525-4252-8252-252525252525";
const googleProfileHash = "e".repeat(64);
const readyGoogleProfileChange = {
  ...request, id: "google-profile-inbox-1", source_system: "aa_console",
  source_kind: "google_profile_change", source_id: googleProfileReviewId,
  source_version: `${googleProfileHash}:${googleProfileToken}`,
  artifact_hash: googleProfileHash, title: "Review Google profile description at Test location",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: "google_profile:accounts/test/locations/one:description",
  account_ref: "accounts/test/locations/one", budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", change_id: "change-1", request_token: googleProfileToken,
    location_id: "location-1", location_ref: "accounts/test/locations/one",
    location_title: "Test location", field: "description",
    current_value: "Old description", proposed_value: "New description" },
  scope: { client_id: "client-1", change_id: "change-1", location_id: "location-1",
    review_id: googleProfileReviewId, request_token: googleProfileToken,
    content_hash: googleProfileHash, effect: "google_profile_proposal_only" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const activationReviewId = "26262626-2626-4262-8262-262626262626";
const activationToken = "27272727-2727-4272-8272-272727272727";
const activationHash = "f".repeat(64);
const readyOpportunityActivation = {
  ...request, id: "activation-inbox-1", source_system: "aa_console",
  source_kind: "opportunity_activate", source_id: activationReviewId,
  source_version: `${activationHash}:${activationToken}`,
  artifact_hash: activationHash, title: "Activate market opportunity: Garage gym",
  source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  destination: "market_opportunity:opportunity-1:active", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", opportunity_id: "opportunity-1",
    request_token: activationToken, activation_note: "Begin planning",
    approved_request_id: "approval-1", approved_content_hash: "a".repeat(64),
    approved_opportunity: { opportunity_id: "opportunity-1", client_id: "client-1" },
    campaigns: [{ campaign_id: "campaign-1", role: "campaign" }] },
  scope: { client_id: "client-1", opportunity_id: "opportunity-1",
    activation_id: activationReviewId, request_token: activationToken,
    content_hash: activationHash, effect: "opportunity_status_active" },
  owning_path: "/clients/client-1/delivery/market-opportunities?opportunity=opportunity-1",
};

const messageReviewId = "29292929-2929-4292-8292-292929292929";
const messageToken = "30303030-3030-4030-8030-303030303030";
const messageHash = "e".repeat(64);
const readyMessageTemplate = {
  ...request, id: "message-inbox-1", source_system: "aa_console",
  source_kind: "message_template", source_id: messageReviewId,
  source_version: `${messageHash}:${messageToken}`, artifact_hash: messageHash,
  title: "Approve message: Enquiry response v1", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "outbound_template:email:version-1", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", template_version_id: "version-1",
    request_token: messageToken, name: "Enquiry response", purpose: "transactional",
    channel: "email", subject: "Your enquiry", body: "Hello Priya.",
    consent_basis: "Lead explicitly requested a reply", channel_supported: true },
  scope: { client_id: "client-1", template_version_id: "version-1",
    review_id: messageReviewId, request_token: messageToken,
    content_hash: messageHash, effect: "standing_template_send_permission" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const sequenceReviewId = "31313131-3131-4131-8131-313131313131";
const sequenceToken = "32323232-3232-4232-8232-323232323232";
const sequenceHash = "d".repeat(64);
const readyNurtureSequence = {
  ...request, id: "sequence-inbox-1", source_system: "aa_console",
  source_kind: "nurture_sequence", source_id: sequenceReviewId,
  source_version: `${sequenceHash}:${sequenceToken}`, artifact_hash: sequenceHash,
  title: "Approve nurture sequence: Guide follow-up", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "nurture_sequence:sequence-1", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", sequence_id: "sequence-1", request_token: sequenceToken,
    name: "Guide follow-up", purpose: "magnet_follow_up", trigger_stage: "profile_visit",
    trigger_after_hours: 24, exit_stages: ["appointment", "sale"],
    enrolled_automatically: true, steps: [{ template_version_id: "version-1",
      body: "Here is your guide.", approval_request_id: "message-inbox-1" }] },
  scope: { client_id: "client-1", sequence_id: "sequence-1", review_id: sequenceReviewId,
    request_token: sequenceToken, content_hash: sequenceHash,
    effect: "standing_sequence_enrolment_permission" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const videoReviewId = "33333333-3333-4333-8333-333333333333";
const videoReviewerId = "34343434-3434-4434-8434-343434343434";
const videoToken = "35353535-3535-4535-8535-353535353535";
const videoHash = "c".repeat(64);
const videoFileHash = "b".repeat(64);
const readyVideoSeat = {
  ...request, id: "video-seat-inbox-1", source_system: "aa_console",
  source_kind: "video_seat", source_id: videoReviewId,
  source_version: `${videoHash}:${videoToken}`, artifact_hash: videoHash,
  title: "Sign video as owner: Exact cut", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "video_seat:owner:asset-1", account_ref: null, budget: null,
  owner_role: `video_owner:${videoReviewerId}`,
  preview: { client_id: "client-1", asset_id: "asset-1", request_token: videoToken,
    approval_role: "owner", assigned_reviewer: videoReviewerId,
    asset: { title: "Exact cut", media_type: "video", edit_stage: "review_ready",
      render_path: "client-1/render.mp4", file_sha256: videoFileHash,
      usage_rights: "agency_owned" },
    storage: { bucket: "client-media", object_id: "storage-object-1", version: "v1" } },
  scope: { client_id: "client-1", asset_id: "asset-1", review_id: videoReviewId,
    approval_role: "owner", assigned_reviewer: videoReviewerId,
    request_token: videoToken, content_hash: videoHash,
    effect: "rendered_video_seat_signoff" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=assets",
};

const motionReviewId = "36363636-3636-4636-8636-363636363636";
const motionToken = "37373737-3737-4737-8737-373737373737";
const motionHash = "d".repeat(64);
const motionFileHash = "e".repeat(64);
const readyMotionRender = {
  ...request, id: "motion-inbox-1", source_system: "aa_console",
  source_kind: "motion_render", source_id: motionReviewId,
  source_version: `${motionHash}:${motionToken}`, artifact_hash: motionHash,
  title: "Accept motion render r1", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "motion_render:candidate-1", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", candidate_id: "candidate-1", project_id: "project-1",
    request_token: motionToken, attempt: 1, render_path: "client-1/motion/r1.mp4",
    render_sha256: motionFileHash, render_file_bytes: 12,
    storage: { bucket: "client-media", object_id: "storage-object-1", version: "v1" },
    qa: { brand: "pass", claim: "pass", proof_source_lost: false }, scenes: [] },
  scope: { client_id: "client-1", candidate_id: "candidate-1", review_id: motionReviewId,
    request_token: motionToken, content_hash: motionHash, effect: "motion_candidate_acceptance" },
  owning_path: "/clients/client-1/delivery/motion-design?tab=renders",
};

const ideaReviewId = "38383838-3838-4838-8838-383838383838";
const ideaToken = "39393939-3939-4939-8939-393939393939";
const ideaHash = "f".repeat(64);
const readyCampaignIdea = {
  ...request, id: "idea-inbox-1", source_system: "aa_console",
  source_kind: "campaign_idea", source_id: ideaReviewId,
  source_version: `${ideaHash}:${ideaToken}`, artifact_hash: ideaHash,
  title: "Select idea: A useful buying trigger", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "internal:brief:idea:idea-1", account_ref: null, budget: null,
  owner_role: "admin_or_active_client_manager",
  preview: { client_id: "client-1", idea_id: "idea-1", request_token: ideaToken,
    selection_route: "human", idea: { id: "idea-1", client_id: "client-1",
      title: "A useful buying trigger", body: "Exact idea direction" },
    campaign: null, proof: null },
  scope: { client_id: "client-1", idea_id: "idea-1", review_id: ideaReviewId,
    request_token: ideaToken, content_hash: ideaHash,
    effect: "human_idea_selection_for_brief" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const switchReviewId = "40404040-4040-4040-8040-404040404040";
const switchToken = "41414141-4141-4141-8141-414141414141";
const switchHash = "c".repeat(64);
const readyActivationSwitch = {
  ...request, id: "switch-inbox-1", source_system: "aa_console",
  source_kind: "activation_switch", source_id: switchReviewId,
  source_version: `${switchHash}:${switchToken}`, artifact_hash: switchHash,
  title: "Enable client automation: outbound messaging", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "client:automation:client-1:outbound_messaging", account_ref: null, budget: null,
  owner_role: "admin",
  preview: { client_id: "client-1", switch_key: "outbound_messaging", action: "enable",
    request_token: switchToken, settings: { client_id: "client-1", outbound_messaging_enabled: false } },
  scope: { client_id: "client-1", switch_key: "outbound_messaging", review_id: switchReviewId,
    request_token: switchToken, content_hash: switchHash,
    effect: "enable_client_automation_switch" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};
const readyBookingActivation = {
  ...readyActivationSwitch, id: "booking-inbox-1",
  title: "Enable client automation: booking",
  destination: "client:automation:client-1:booking",
  preview: { client_id: "client-1", switch_key: "booking", action: "enable",
    request_token: switchToken, settings: { client_id: "client-1", enabled: false,
      timezone: "Europe/Monaco", slot_minutes: 30 },
    windows: [{ day_of_week: 1, starts_at_minute: 540, ends_at_minute: 720 }] },
  scope: { ...readyActivationSwitch.scope, switch_key: "booking" },
};
const leadCaptureId = "42424242-4242-4242-8242-424242424242";
const readyLeadCaptureActivation = {
  ...readyActivationSwitch, id: "lead-capture-inbox-1",
  title: "Enable client automation: lead capture",
  destination: `client:automation:client-1:lead_capture:${leadCaptureId}`,
  preview: { client_id: "client-1", switch_key: "lead_capture", action: "enable",
    request_token: switchToken, target_id: leadCaptureId,
    endpoint: { id: leadCaptureId, client_id: "client-1", enabled: false,
      token_hash: "d".repeat(64), consent_wording: "I agree to be contacted",
      expires_at: "2030-01-01T00:00:00Z", max_submissions: 500,
      submissions: 0, revoked_at: null } },
  scope: { ...readyActivationSwitch.scope, switch_key: "lead_capture", target_id: leadCaptureId },
};
const globalReviewId = "43434343-4343-4343-8343-434343434343";
const globalToken = "44444444-4444-4444-8444-444444444444";
const globalHash = "e".repeat(64);
const readyGlobalEngineActivation = {
  ...request, id: "global-engine-inbox-1", client_id: null,
  source_system: "aa_console", source_kind: "global_engine_activation",
  source_id: globalReviewId, source_version: `${globalHash}:${globalToken}`,
  artifact_hash: globalHash, title: "Enable the system-wide content Engine",
  status: "pending", source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  preview_blocker: null, destination: "system:content_engine", account_ref: null,
  budget: null, owner_role: "admin", owning_path: "/approvals",
  preview: { action: "enable_system_engine", request_token: globalToken,
    global_control: { enabled: false, note: null }, client_scope: [] },
  scope: { effect: "enable_global_content_engine", review_id: globalReviewId,
    request_token: globalToken, content_hash: globalHash,
    client_scope: "all individually enabled clients until manually disabled" },
};
const globalOwnerReviewId = "50505050-5050-4050-8050-505050505050";
const globalOwnerToken = "51515151-5151-4151-8151-515151515151";
const globalOwnerHash = "2".repeat(64);
const readyGlobalVideoOwner = {
  ...request, id: "global-owner-inbox-1", client_id: null,
  source_system: "aa_console", source_kind: "global_video_owner",
  source_id: globalOwnerReviewId, source_version: `${globalOwnerHash}:${globalOwnerToken}`,
  artifact_hash: globalOwnerHash, title: "Assign global video approval owner",
  status: "pending", source_state: "pending", expires_at: "2030-01-01T00:00:00Z",
  preview_blocker: null, destination: "agency:video_approval_owner", account_ref: null,
  budget: null, owner_role: "admin", owning_path: "/approvals",
  preview: { action: "assign_global_video_approval_owner", request_token: globalOwnerToken,
    current_owner: "admin-old", proposed_owner: "admin-new", proposed_owner_role: "admin" },
  scope: { effect: "change_global_video_approval_owner", review_id: globalOwnerReviewId,
    request_token: globalOwnerToken, content_hash: globalOwnerHash,
    proposed_owner: "admin-new" },
};

const integrationReviewId = "45454545-4545-4545-8545-454545454545";
const integrationId = "46464646-4646-4646-8646-464646464646";
const integrationToken = "47474747-4747-4747-8747-474747474747";
const integrationHash = "f".repeat(64);
const readyIntegrationGrant = {
  ...request, id: "integration-inbox-1", source_system: "aa_console",
  source_kind: "integration_grant", source_id: integrationReviewId,
  source_version: `${integrationHash}:${integrationToken}`, artifact_hash: integrationHash,
  title: "Grant meta credential access for act_123", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: `client:integration:client-1:${integrationId}`, account_ref: "act_123",
  budget: null, owner_role: "admin",
  preview: { client_id: "client-1", integration_id: integrationId,
    request_token: integrationToken, action: "grant_provider_access", provider: "meta",
    account_label: "act_123", access_level: "read", recorded_status: "pending_grant",
    credential_version_hash: "a".repeat(64), enable_daily_ingest: true },
  scope: { client_id: "client-1", integration_id: integrationId, review_id: integrationReviewId,
    request_token: integrationToken, content_hash: integrationHash,
    enable_daily_ingest: true, effect: "grant_client_provider_credential_use" },
  owning_path: "/clients/client-1/account/integrations",
};
const backfillReviewId = "51515151-5151-4515-8515-515151515151";
const backfillToken = "52525252-5252-4525-8525-525252525252";
const backfillHash = "2".repeat(64);
const readyMetricsBackfill = {
  ...request, id: "metrics-backfill-inbox-1", source_system: "aa_console",
  source_kind: "metrics_backfill", source_id: backfillReviewId,
  source_version: `${backfillHash}:${backfillToken}`, artifact_hash: backfillHash,
  title: "Pull paid metrics history", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "client:metrics:client-1:paid", account_ref: null,
  budget: null, owner_role: "admin", owning_path: "/clients/client-1/account/integrations",
  preview: { client_id: "client-1", action: "pull_metrics_history",
    since: "2026-10-01", until: "2026-10-07", surface: "paid", request_token: backfillToken,
    accounts: [{ surface: "paid", provider: "meta", credential_version_hash: "a".repeat(64) }] },
  scope: { client_id: "client-1", review_id: backfillReviewId,
    request_token: backfillToken, content_hash: backfillHash,
    effect: "queue_metrics_backfill", surfaces: "paid",
    since: "2026-10-01", until: "2026-10-07" },
};
const creativeReviewId = "48484848-4848-4848-8848-484848484848";
const creativeToken = "49494949-4949-4949-8949-494949494949";
const creativeHash = "1".repeat(64);
const readyCreativeRequirement = {
  ...request, id: "creative-requirement-inbox-1", source_system: "aa_console",
  source_kind: "creative_requirement", source_id: creativeReviewId,
  source_version: `${creativeHash}:${creativeToken}`, artifact_hash: creativeHash,
  title: "Require creative director sign-off", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "client:creative_authority:client-1", account_ref: null,
  budget: null, owner_role: "admin",
  preview: { client_id: "client-1", request_token: creativeToken,
    action: "change_creative_approval_requirement", current_required: false,
    proposed_required: true, current_creative_director: "director-1",
    current_smm: "smm-1" },
  scope: { client_id: "client-1", review_id: creativeReviewId,
    request_token: creativeToken, content_hash: creativeHash,
    proposed_required: true, effect: "change_creative_approval_authority" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};
const authorityReviewId = "52525252-5252-4252-8252-525252525252";
const authorityToken = "53535353-5353-4353-8353-535353535353";
const authorityHash = "3".repeat(64);
const readyClientAuthorityAssignment = {
  ...request, id: "client-authority-inbox-1", source_system: "aa_console",
  source_kind: "client_authority_assignment", source_id: authorityReviewId,
  source_version: `${authorityHash}:${authorityToken}`, artifact_hash: authorityHash,
  title: "Assign SMM seat", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "client:approval_seat:client-1:member-1", account_ref: null,
  budget: null, owner_role: "admin",
  preview: { client_id: "client-1", member_id: "member-1", request_token: authorityToken,
    action: "assign", member: { id: "member-1", category: "smm", user_id: "employee-1" },
    current_assignment: null, active_same_category: [], proposed_due_date: null,
    proposed_compensation: null },
  scope: { client_id: "client-1", member_id: "member-1", review_id: authorityReviewId,
    request_token: authorityToken, content_hash: authorityHash, action: "assign",
    effect: "change_client_approval_seat" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};
const gatewayApprovalId = "54545454-5454-4454-8454-545454545454";
const gatewayToken = "55555555-5555-4555-8555-555555555555";
const gatewayHash = "4".repeat(64);
const readyGatewayTool = {
  ...request, id: "gateway-tool-inbox-1", source_system: "aa_console",
  source_kind: "gateway_tool", source_id: gatewayApprovalId,
  source_version: `${gatewayHash}:${gatewayToken}`, artifact_hash: gatewayHash,
  title: "Gateway tool: workflow.create_approval", status: "pending", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", preview_blocker: null,
  destination: "gateway:bot_production:workflow.create_approval", account_ref: null,
  budget: null, owner_role: "admin",
  preview: { gateway_approval_id: gatewayApprovalId, client_id: "client-1",
    bot_id: "bot_production", token_id: "token-1", tool: "workflow.create_approval",
    risk: "MEDIUM", summary: "Review production plan", structured_payload: { client_id: "client-1" },
    payload_hash: "a".repeat(64), request_token: gatewayToken,
    consequence: "Informational gateway ticket only; no AA action" },
  scope: { client_id: "client-1", gateway_approval_id: gatewayApprovalId,
    bot_id: "bot_production", token_id: "token-1", tool: "workflow.create_approval",
    payload_hash: "a".repeat(64), content_hash: gatewayHash, request_token: gatewayToken,
    effect: "allow_one_gateway_tool_execution" },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=unified",
};

const engineSlotId = "18181818-1818-4818-8818-181818181818";
const engineEntryId = "19191919-1919-4919-8919-191919191919";
const engineTime = "2026-11-20T09:00:00+00:00";
const readyEngineSlot = {
  ...request, id: "engine-slot-inbox-1", source_system: "aa_console",
  source_kind: "engine_slot", source_id: engineSlotId,
  source_version: engineEntryId, artifact_hash: "b".repeat(64),
  title: "Engine slot: Client image", source_state: "pending",
  expires_at: "2030-01-01T00:00:00Z", destination: "organic:instagram",
  account_ref: "17890000000000000", budget: null, owner_role: "client_media_reviewer",
  preview: { exact_package: { client_id: "client-1",
    slot: { id: engineSlotId, asset_id: mediaAssetId, platform: "instagram",
      scheduled_at: engineTime, format: "single" },
    asset: { id: mediaAssetId, client_id: "client-1", title: "Client image",
      media_type: "image", content_format: "single", storage_path: "client-1/image.png",
      file_sha256: mediaFileHash, usage_rights: "agency_owned" },
    storage: { bucket: "client-media", object_id: "storage-object-1", version: "v1" },
    post_copy: [{ platform: "instagram", caption: "Exact caption" }],
    account_ref: "17890000000000000" } },
  scope: { client_id: "client-1", slot_id: engineSlotId, asset_id: mediaAssetId,
    platform: "instagram", scheduled_at: engineTime, format: "single",
    approval_entry_id: engineEntryId },
  owning_path: "/clients/client-1/delivery/approval-inbox?tab=engine",
};

function wireDatabase() {
  from.mockImplementation((table: string) => {
    let id: string | null = null;
    const filters: Array<[string, string | null]> = [];
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === "id") id = value;
        if (column === "client_id" && table === "approval_inbox_v6") clientEqValues.push(value);
        filters.push([column, value]);
        return query;
      },
      is: (column: string, value: null) => { filters.push([column, value]); return query; },
      in: (_column: string, ids: string[]) => {
        historyIds.push(ids);
        if (table === "campaign_action_due") return Promise.resolve({ data: campaignDueRows, error: null });
        return query;
      },
      maybeSingle: async () => ({
        data: freshRequest === undefined ? requests.find((row) => (row as { id: string }).id === id) ?? null : freshRequest,
        error: requestError,
      }),
      order: () => table === "approval_inbox_v6" ? query
        : Promise.resolve({ data: decisions, error: decisionError }),
      range: async (start: number, end: number) => {
        requestRanges.push([start, end]);
        const filtered = requests.filter((row) => filters.every(([column, value]) =>
          (row as Record<string, unknown>)[column] === value));
        return { data: filtered.slice(start, end + 1), error: requestError };
      },
    };
    return query;
  });
}

function show(scope: "client" | "global" | "manager" = "client", path = "/approvals") {
  return render(<MemoryRouter initialEntries={[path]}><UnifiedApprovalInboxPanel scope={scope} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCreativeReviewIntake.mockReset().mockResolvedValue([]);
  requestOrdinaryMediaReview.mockReset();
  requests = [request];
  decisions = [];
  gatewayOutcomes = [];
  requestError = null;
  decisionError = null;
  freshRequest = undefined;
  clientEqValues = [];
  requestRanges = [];
  historyIds = [];
  campaignDueRows = [];
  proofOutcomeRows = [];
  getAAL.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
  rpc.mockImplementation((name: string) => name === "list_gateway_tool_execution_overview_v6"
    ? { select: () => ({ order: async () => ({ data: gatewayOutcomes, error: null }) }) }
    : name === "list_proof_approval_execution_evidence_v6"
      ? { select: () => ({ in: async () => ({ data: proofOutcomeRows, error: null }) }) }
    : name.startsWith("list_")
      ? { select: () => ({ in: async () => ({ data: [], error: null }) }) }
      : Promise.resolve({ data: null, error: null }));
  wireDatabase();
});

describe("unified approval inbox", () => {
  it("routes unsubmitted creative through the exact review request flow", async () => {
    requests = [];
    loadCreativeReviewIntake.mockResolvedValueOnce([{ id: "asset-1", title: "Spring creative", media_type: "image" }]);
    requestOrdinaryMediaReview.mockImplementationOnce(async () => {
      requests = [readyOrdinaryMedia];
      return mediaReviewId;
    });
    render(<MemoryRouter><UnifiedApprovalInboxPanel pendingTable /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: "Spring creative" }))
      .toHaveAttribute("href", "/clients/client-1/delivery/approval-inbox?tab=assets&media=image&asset=asset-1");
    await userEvent.setup().click(screen.getByRole("button", { name: "Request review" }));
    expect(requestOrdinaryMediaReview).toHaveBeenCalledWith("client-1", "asset-1");
    expect(await screen.findByRole("button", { name: `Approve ${readyOrdinaryMedia.title}` })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Request review" })).not.toBeInTheDocument();
  });

  it("links pending rows to their source and removes a row after exact approval", async () => {
    const user = userEvent.setup();
    requests = [readyCampaign];
    render(<MemoryRouter><UnifiedApprovalInboxPanel pendingTable /></MemoryRouter>);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: readyCampaign.title }))
      .toHaveAttribute("href", readyCampaign.owning_path);
    expect(within(table).getByRole("button", { name: `Delete ${readyCampaign.title}` })).toBeEnabled();
    await user.click(within(table).getByRole("button", { name: `Approve ${readyCampaign.title}` }));
    expect(rpc).not.toHaveBeenCalledWith("decide_campaign_action_approval_v6", expect.anything());
    rpc.mockImplementation(async () => {
      requests = [];
      return { data: null, error: null };
    });
    const dialog = screen.getByRole("dialog", { name: "Approve request" });
    await user.click(within(dialog).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText("No pending approvals.")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
      p_request_id: "action-1", p_decision: "approved",
    });
  });

  it("shows a proof delivery send as recorded without claiming recipient receipt", async () => {
    requests = [{ ...readyProofDelivery, status: "approved" }];
    proofOutcomeRows = [{ request_id: readyProofDelivery.id, client_id: "client-1",
      source_kind: "proof_delivery", state: "sent",
      detail: "A provider send is recorded for this delivery. The attempt is not bound to this exact approval request; recipient receipt is not proved.",
      external_ref: "provider-message-1" }];
    show("client", `/approvals?source=${proofDeliveryReviewId}`);
    const card = await screen.findByRole("article", { name: readyProofDelivery.title });
    expect(within(card).getByText("Recorded state: sent")).toBeInTheDocument();
    expect(within(card).getByText(/recipient receipt is not proved/)).toBeInTheDocument();
    expect(within(card).getByText("External reference: provider-message-1")).toBeInTheDocument();
  });

  it("shows an approved campaign action's execution separately from its decision", async () => {
    requests = [{ ...readyCampaign, status: "approved" }];
    campaignDueRows = [{ approval_id: "action-1", client_id: "client-1",
      execution_status: "executed", blocker: null, external_id: "provider-123",
      external_url: null }];
    show("client", "/approvals?source=action-1");
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).getByText("Execution evidence")).toBeInTheDocument();
    expect(within(card).getByText("Recorded state: executed")).toBeInTheDocument();
    expect(within(card).getByText("External reference: provider-123")).toBeInTheDocument();
    expect(within(card).getByText(/Approval and execution are separate/)).toBeInTheDocument();
  });

  it("shows only manager-owned cards across assigned clients and no admin source links", async () => {
    requests = [
      { ...readyCampaign, id: "manager-client-1", title: "Client one action",
        owner_role: "admin_or_active_client_manager" },
      { ...readyCampaign, id: "manager-client-2", title: "Client two action",
        client_id: "client-2", owner_role: "admin_or_active_client_manager",
        owning_path: "/clients/client-2/delivery/approval-inbox?tab=campaign-actions" },
      { ...readyCampaign, id: "house-card", title: "Agency private request",
        client_id: null, owner_role: "admin" },
    ];
    show("manager", "/employee/approvals");
    expect(await screen.findByRole("heading", { name: "Manager approval inbox" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Client one action" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Client two action" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Agency private request" })).not.toBeInTheDocument();
    expect(clientEqValues).toEqual([]);
    expect(screen.queryByRole("link", { name: "View owning source" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Owning source is unavailable from the manager console.")).toHaveLength(2);
  });

  it("shows the exact artifact, destination, account, budget, scope, owner and source", async () => {
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).getByText("Exact headline", { exact: false })).toBeInTheDocument();
    expect(within(card).getByText("a".repeat(64))).toBeInTheDocument();
    expect(within(card).getByText("meta:act_123")).toBeInTheDocument();
    expect(within(card).getByText("act_123")).toBeInTheDocument();
    expect(within(card).getByText(/daily_spend_limit/)).toBeInTheDocument();
    expect(within(card).getByText(/placement/)).toBeInTheDocument();
    expect(within(card).getByText("admin")).toBeInTheDocument();
    expect(within(card).getByText("service · campaign_action_approvals:source-1"))
      .toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "View owning source" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/approval-inbox?tab=campaign-actions",
    );
    expect(within(card).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(from).toHaveBeenCalledWith("approval_inbox_v6");
  });

  it("pages all matching requests in bounded batches and bounds decision history IDs", async () => {
    requests = Array.from({ length: 60 }, (_, index) => ({
      ...request, id: `request-${index}`, source_id: `action-${index}`,
      title: `Queued ${index}`,
    }));
    show("global");
    expect(await screen.findByRole("article", { name: "Queued 0" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Queued 50" })).not.toBeInTheDocument();
    expect(requestRanges).toContainEqual([0, 50]);
    expect(historyIds.every((ids) => ids.length <= 50)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("article", { name: "Queued 50" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Queued 0" })).not.toBeInTheDocument();
    expect(requestRanges).toContainEqual([50, 100]);
    expect(historyIds.at(-1)).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByRole("article", { name: "Queued 0" })).toBeInTheDocument();
  });

  it("finds a deep-linked source even when it would be beyond the first page", async () => {
    requests = Array.from({ length: 60 }, (_, index) => ({
      ...request, id: `request-${index}`, source_id: index === 59 ? "brief-59" : `action-${index}`,
      title: index === 59 ? "Exact linked brief" : `Queued ${index}`,
      status: index === 59 ? "approved" : "pending",
    }));
    show("global", "/approvals?source=brief-59");
    expect(await screen.findByRole("article", { name: "Exact linked brief" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(historyIds.at(-1)).toHaveLength(1);
  });

  it("applies exact source and client filters to requests beyond the first page", async () => {
    requests = Array.from({ length: 60 }, (_, index) => ({
      ...request, id: `request-${index}`, source_id: `action-${index}`,
      title: index === 59 ? "Off-page source" : `Queued ${index}`,
      client_id: index === 59 ? "client-59" : "client-1",
      source_kind: index === 59 ? "future_source_kind" : "campaign_action",
    }));
    show("global");
    expect(await screen.findByRole("article", { name: "Queued 0" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Off-page source" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Client ID"), "client-59");
    await userEvent.type(screen.getByLabelText("Source type"), "future_source_kind");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByRole("article", { name: "Off-page source" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Queued 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(clientEqValues).toContain("client-59");
    expect(historyIds.at(-1)).toEqual(["request-59"]);
  });

  it("treats a literal all source kind as an exact filter, then clears it to any source", async () => {
    const user = userEvent.setup();
    requests = [
      { ...request, id: "request-all", title: "Literal all source", source_kind: "all" },
      { ...request, id: "request-campaign", title: "Campaign action source" },
    ];
    show("global");
    expect(await screen.findByRole("article", { name: "Literal all source" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Campaign action source" })).toBeInTheDocument();

    const sourceInput = screen.getByLabelText("Source type");
    await user.type(sourceInput, "all");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Campaign action source" }))
      .not.toBeInTheDocument());
    expect(screen.getByRole("article", { name: "Literal all source" })).toBeInTheDocument();
    expect(historyIds.at(-1)).toEqual(["request-all"]);
    expect(screen.getByRole("status", { name: "", hidden: false })).toHaveTextContent("source all");

    await user.clear(sourceInput);
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByRole("article", { name: "Campaign action source" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Literal all source" })).toBeInTheDocument();
    expect(historyIds.at(-1)).toEqual(["request-all", "request-campaign"]);
  });

  it("filters agency-wide requests by a null client without inventing a client ID", async () => {
    requests = [request, { ...request, id: "agency-1", client_id: null,
      title: "Agency release decision" }];
    show("global");
    expect(await screen.findByRole("article", { name: "Build the Meta ad" }))
      .toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Client ID"), "agency-wide");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByRole("article", { name: "Agency release decision" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Build the Meta ad" }))
      .not.toBeInTheDocument();
    expect(clientEqValues).toEqual([]);
  });

  it("makes missing exact preview and hash explicit without offering approval", async () => {
    requests = [{ ...request, preview: null, artifact_hash: null,
      preview_blocker: "Legacy request has no frozen words." }];
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).getByRole("alert")).toHaveTextContent("Legacy request has no frozen words.");
    expect(within(card).getByText(/not decision-ready/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("keeps cross-client and external source links out of the inbox", async () => {
    requests = [{ ...request, owning_path: "/clients/client-1/../other-client/delivery/approval-inbox" },
      { ...request, id: "request-2", title: "Outside link", owning_path: "https://other.example/approve" }];
    show();
    expect(await screen.findByText("Build the Meta ad")).toBeInTheDocument();
    expect(screen.getAllByText("Owning source link unavailable.")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "View owning source" })).not.toBeInTheDocument();
  });

  it("links only an admin recruitment brief to the exact team route", async () => {
    requests = [
      { ...request, id: "recruitment", title: "Editor brief", source_system: "aa_console",
        source_kind: "recruitment_brief", owning_path: "/team?tab=recruitment" },
      { ...request, id: "other-kind", title: "Other team card", source_system: "aa_console",
        source_kind: "campaign_action", owning_path: "/team?tab=recruitment" },
      { ...request, id: "other-client", title: "Cross-client brief", client_id: "client-2",
        source_system: "aa_console", source_kind: "recruitment_brief",
        owning_path: "/team?tab=recruitment" },
      { ...request, id: "alternate-route", title: "Other team tab", source_system: "aa_console",
        source_kind: "recruitment_brief", owning_path: "/team?tab=admin" },
    ];
    show();
    const recruitment = await screen.findByRole("article", { name: "Editor brief" });
    expect(within(recruitment).getByRole("link", { name: "View owning source" }))
      .toHaveAttribute("href", "/team?tab=recruitment");
    expect(screen.queryByRole("article", { name: "Cross-client brief" })).not.toBeInTheDocument();
    for (const title of ["Other team card", "Other team tab"]) {
      expect(within(screen.getByRole("article", { name: title }))
        .queryByRole("link", { name: "View owning source" })).not.toBeInTheDocument();
    }
  });

  it("filters across statuses and source types and shows decision history", async () => {
    const user = userEvent.setup();
    requests = [request, { ...request, id: "request-2", title: "Proof placement",
      source_kind: "proof_placement", status: "approved", destination: "directory" }];
    decisions = [{ request_id: "request-2", decision: "approved", actor_id: "human-1",
      actor_aal: "aal2", reason: "Rights verified", decided_at: "2026-10-30T09:00:00Z" }];
    show();
    expect(await screen.findByText("Build the Meta ad")).toBeInTheDocument();
    expect(screen.queryByText("Proof placement")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "approved");
    expect(screen.getByText("Proof placement")).toBeInTheDocument();
    expect(screen.queryByText("Build the Meta ad")).not.toBeInTheDocument();
    await user.click(screen.getByText("Decision history (1)"));
    expect(screen.getByText(/Human: human-1 · Assurance: aal2/)).toBeInTheDocument();
    expect(screen.getByText("Reason: Rights verified")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    await user.type(screen.getByLabelText("Source type"), "campaign_action");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(screen.getByText("Build the Meta ad")).toBeInTheDocument();
    expect(screen.queryByText("Proof placement")).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search current page" }), "no match");
    expect(screen.getByText("No requests match these filters.")).toBeInTheDocument();
  });

  it("shows a superseded source card as terminal and removes its decision controls", async () => {
    requests = [{ ...readyCampaign, status: "superseded", source_state: "superseded" }];
    show("client", "/approvals?source=action-1");
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).getByText("Live source state")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "The owning source is superseded. This card cannot be decided.",
    );
    expect(within(card).queryByRole("button", { name: "Approve exact version" }))
      .not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject with reason" }))
      .not.toBeInTheDocument();
  });

  it("does not suggest the queue is empty when decision history fails", async () => {
    decisionError = { message: "History unavailable" };
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.queryByText(/No requests have been mirrored yet/)).not.toBeInTheDocument();
    decisionError = null;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Build the Meta ad")).toBeInTheDocument());
  });

  it("shows page HTML only in a sandboxed preview with external resources blocked", async () => {
    requests = [{ ...request, preview: { rendered_html: "<html><body>Exact offer</body></html>" } }];
    show();
    await screen.findByText("Build the Meta ad");
    await userEvent.click(screen.getByText("Visual page preview"));
    const iframe = screen.getByTitle("Preview of Build the Meta ad");
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe.getAttribute("srcdoc")).toContain("default-src 'none'");
  });

  it("decides a complete campaign action through its owning RPC and refreshes history", async () => {
    const user = userEvent.setup();
    requests = [readyCampaign];
    rpc.mockImplementation(async () => {
      requests = [{ ...readyCampaign, status: "approved" }];
      decisions = [{ request_id: readyCampaign.id, decision: "approved", actor_id: "human-1",
        actor_aal: "aal2", reason: null, decided_at: "2026-10-30T09:00:00Z" }];
      return { data: null, error: null };
    });
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
      p_request_id: "action-1", p_decision: "approved",
    }));
    await waitFor(() => expect(screen.getByText("Decision history (1)")).toBeInTheDocument());
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("reviews the exact offer in the unified inbox and calls its owning AAL2 signoff", async () => {
    const user = userEvent.setup();
    requests = [readyOffer];
    show();
    const card = await screen.findByRole("article", { name: readyOffer.title });
    expect(within(card).getByText("Service offer decision")).toBeInTheDocument();
    expect(within(card).getByText(/Clear plan/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_service_offer_version_v6", {
      p_version_id: offerVersionId,
    }));
  });

  it("reviews the frozen campaign preparation package through its own decision RPC", async () => {
    requests = [readyPreparation];
    show();
    const card = await screen.findByRole("article", { name: readyPreparation.title });
    expect(within(card).getByText("Campaign preparation package decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_preparation_package_v7", {
      p_package_id: packageId, p_request_id: readyPreparation.id, p_approved: true,
    }));
  });

  it("reviews the exact Google manual operator bundle through its own decision RPC", async () => {
    requests = [readyGoogleOperator];
    show();
    const card = await screen.findByRole("article", { name: readyGoogleOperator.title });
    expect(within(card).getByText("Google manual operator bundle decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_google_operator_bundle_v7", {
      p_bundle_id: googleBundleId, p_request_id: readyGoogleOperator.id, p_approved: true,
    }));
  });

  it("reviews the route-bound paid operator packet and its human instructions", async () => {
    requests = [readyPaidOperator];
    show();
    const card = await screen.findByRole("article", { name: readyPaidOperator.title });
    expect(within(card).getByText("Paid operator bundle decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_paid_operator_bundle_v7", {
      p_bundle_id: paidBundleId, p_request_id: readyPaidOperator.id, p_approved: true,
    }));
  });

  it("reviews the frozen organic publication package through its exact decision RPC", async () => {
    requests = [readyOrganicPublication];
    show();
    const card = await screen.findByRole("article", { name: readyOrganicPublication.title });
    expect(within(card).getByText("Organic publication package decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_organic_publication_v7", {
      p_package_id: organicPackageId, p_request_id: readyOrganicPublication.id, p_approved: true,
    }));
  });

  it("holds an organic package with missing media rights", async () => {
    requests = [{ ...readyOrganicPublication,
      preview: { ...readyOrganicPublication.preview, rights: { usage_rights: null } } }];
    show();
    const card = await screen.findByRole("article", { name: readyOrganicPublication.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).toBeNull();
  });

  it("reviews exact Google search copy through its paid-route decision RPC", async () => {
    requests = [readyGoogleCopy];
    show();
    const card = await screen.findByRole("article", { name: readyGoogleCopy.title });
    expect(within(card).getByText("Google search copy decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_google_search_copy_v7", {
      p_copy_id: googleCopyId, p_request_id: readyGoogleCopy.id, p_approved: true,
    }));
  });

  it("decides the frozen public sales-agent script through its owning AAL2 RPC", async () => {
    requests = [readyPublicAgent];
    show();
    const card = await screen.findByRole("article", { name: readyPublicAgent.title });
    expect(within(card).getByText("Sales agent public use decision")).toBeInTheDocument();
    expect(within(card).getByText(/Answer accurately/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_sales_agent_public_use_v6", {
      p_agent_id: publicAgentId, p_request_id: readyPublicAgent.id,
    }));
  });

  it("decides the exact evaluated opportunity through its owning RPC", async () => {
    requests = [readyOpportunity];
    show();
    const card = await screen.findByRole("article", { name: readyOpportunity.title });
    expect(within(card).getByText("Market opportunity decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_opportunity_v6", {
      p_opportunity_id: opportunityId, p_request_id: readyOpportunity.id,
    }));
  });

  it("clears the exact text proof through its owning rights RPC", async () => {
    requests = [readyProofRights];
    show();
    const card = await screen.findByRole("article", { name: readyProofRights.title });
    expect(within(card).getByText("Proof usage rights decision")).toBeInTheDocument();
    expect(within(card).getByText(/Customer signed release/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_proof_rights_v6", {
      p_rights_request_id: proofRightsId, p_canonical_id: readyProofRights.id,
    }));
  });

  it("shows a trusted stored-image digest on the rights decision", async () => {
    requests = [{ ...readyProofRights, id: "proof-media-inbox-1",
      preview: { ...readyProofRights.preview,
        proof: { id: proofId, media_type: "image", storage_path: "client-1/proof/photo.png",
          title: "Customer photo" },
        verified_storage_sha256: "6".repeat(64), verified_file_bytes: 4096,
        verified_storage_path: "client-1/proof/photo.png",
        verified_storage_object_id: "77777777-7777-4777-8777-777777777777",
        verified_storage_object_version: "v1",
        verified_storage_object_updated_at: "2026-11-14T10:00:00Z" } }];
    show();
    const card = await screen.findByRole("article", { name: readyProofRights.title });
    expect(within(card).getByText(/Customer photo/)).toBeInTheDocument();
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedProofFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify proof file" }));
    await waitFor(() => expect(downloadVerifiedProofFile).toHaveBeenCalledWith(
      "client-1/proof/photo.png", "6".repeat(64), 4096));
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_proof_rights_v6", {
      p_rights_request_id: proofRightsId, p_canonical_id: "proof-media-inbox-1",
    }));
  });

  it("releases standalone text proof for placement through its owning AAL2 RPC", async () => {
    requests = [readyProofPlacement];
    show();
    const card = await screen.findByRole("article", { name: readyProofPlacement.title });
    expect(within(card).getByText("Proof placement decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_proof_placement_inbox_v6", {
      p_approval_id: placementApprovalId, p_request_id: readyProofPlacement.id,
      p_approved: true,
    }));
  });

  it("signs off the exact proof artifact and source through the owning AAL2 RPC", async () => {
    requests = [readyProofArtifact];
    show();
    const card = await screen.findByRole("article", { name: readyProofArtifact.title });
    expect(within(card).getByText("Proof artifact decision")).toBeInTheDocument();
    expect(within(card).getByText(/Customer result with supported evidence/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_proof_artifact_inbox_v6", {
      p_review_id: artifactReviewId, p_request_id: readyProofArtifact.id,
    }));
  });

  it("routes an exact proof request send decision through its owning Inbox RPC", async () => {
    requests = [readyProofDelivery];
    show();
    const card = await screen.findByRole("article", { name: readyProofDelivery.title });
    expect(within(card).getByText(/Please send evidence/)).toBeInTheDocument();
    expect(within(card).getByText(/resend:Proof <proof@example.invalid>/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_proof_delivery_inbox_v6", {
      p_review_id: proofDeliveryReviewId, p_request_id: readyProofDelivery.id,
      p_approved: true,
    }));
  });

  it("holds a proof request whose reviewed sender is missing", async () => {
    requests = [{ ...readyProofDelivery, preview: {
      ...readyProofDelivery.preview, sender_ref: undefined,
    } }];
    show();
    const card = await screen.findByRole("article", { name: readyProofDelivery.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("routes an exact Meta profile proposal through its owning Inbox RPC", async () => {
    requests = [readyMetaProfileChange];
    show();
    const card = await screen.findByRole("article", { name: readyMetaProfileChange.title });
    expect(within(card).getByText(/New bio/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_meta_profile_inbox_v6", {
      p_review_id: metaProfileReviewId, p_request_id: readyMetaProfileChange.id,
      p_approved: true,
    }));
  });

  it("routes an exact Google profile proposal through its owning Inbox RPC", async () => {
    requests = [readyGoogleProfileChange];
    show();
    const card = await screen.findByRole("article", { name: readyGoogleProfileChange.title });
    expect(within(card).getByText(/New description/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_google_profile_inbox_v6", {
      p_review_id: googleProfileReviewId, p_request_id: readyGoogleProfileChange.id,
      p_approved: true,
    }));
  });

  it("routes opportunity activation through a separate exact Inbox decision", async () => {
    requests = [readyOpportunityActivation];
    show();
    const card = await screen.findByRole("article", { name: readyOpportunityActivation.title });
    expect(within(card).getByText(/Begin planning/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_opportunity_activation_inbox_v6", {
      p_activation_id: activationReviewId, p_request_id: readyOpportunityActivation.id,
      p_approved: true,
    }));
  });

  it("decides the exact message words and consent basis through the Inbox", async () => {
    requests = [readyMessageTemplate];
    show();
    const card = await screen.findByRole("article", { name: readyMessageTemplate.title });
    expect(within(card).getByText(/Lead explicitly requested a reply/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_message_template_inbox_v6", {
      p_review_id: messageReviewId, p_request_id: readyMessageTemplate.id,
      p_approved: true,
    }));
  });

  it("decides the ordered nurture steps and enrolment settings through the Inbox", async () => {
    requests = [readyNurtureSequence];
    show();
    const card = await screen.findByRole("article", { name: readyNurtureSequence.title });
    expect(within(card).getByText(/Here is your guide/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_nurture_sequence_inbox_v6", {
      p_review_id: sequenceReviewId, p_request_id: readyNurtureSequence.id,
      p_approved: true,
    }));
  });

  it("requires exact rendered-video download before its assigned seat decision", async () => {
    requests = [readyVideoSeat];
    show();
    const card = await screen.findByRole("article", { name: readyVideoSeat.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/render.mp4", videoFileHash));
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_video_seat_inbox_v6", {
      p_review_id: videoReviewId, p_request_id: readyVideoSeat.id,
      p_approved: true,
    }));
  });

  it("requires motion render download before an exact Inbox decision", async () => {
    requests = [readyMotionRender];
    show();
    const card = await screen.findByRole("article", { name: readyMotionRender.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/motion/r1.mp4", motionFileHash));
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_motion_render_inbox_v6", {
      p_review_id: motionReviewId, p_request_id: readyMotionRender.id, p_approved: true,
    }));
  });

  it("routes an exact human idea selection through the Inbox", async () => {
    requests = [readyCampaignIdea];
    show();
    const card = await screen.findByRole("article", { name: readyCampaignIdea.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_human_idea_inbox_v6", {
      p_review_id: ideaReviewId, p_request_id: readyCampaignIdea.id,
      p_approved: true,
    }));
  });

  it("routes an exact client automation activation through the Inbox", async () => {
    requests = [readyActivationSwitch];
    show();
    const card = await screen.findByRole("article", { name: readyActivationSwitch.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_switch_activation_v6", {
      p_review_id: switchReviewId, p_request_id: readyActivationSwitch.id,
      p_approved: true,
    }));
  });

  it.each([readyBookingActivation, readyLeadCaptureActivation])(
    "routes exact activation for $title", async (activation) => {
      requests = [activation];
      show();
      const card = await screen.findByRole("article", { name: activation.title });
      await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
      await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_switch_activation_v6", {
        p_review_id: switchReviewId, p_request_id: activation.id, p_approved: true,
      }));
    });

  it("decides the exact agency-wide Engine card without inventing a client ID", async () => {
    requests = [readyGlobalEngineActivation];
    show("global");
    const card = await screen.findByRole("article", { name: readyGlobalEngineActivation.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_global_engine_activation_v6", {
      p_review_id: globalReviewId, p_request_id: readyGlobalEngineActivation.id,
      p_approved: true,
    }));
    expect(clientEqValues).toEqual([]);
  });

  it("decides an agency-wide video owner card without inventing a client ID", async () => {
    requests = [readyGlobalVideoOwner];
    show("global");
    const card = await screen.findByRole("article", { name: readyGlobalVideoOwner.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_global_video_owner_v6", {
      p_review_id: globalOwnerReviewId, p_request_id: readyGlobalVideoOwner.id,
      p_approved: true,
    }));
    expect(clientEqValues).toEqual([]);
  });

  it("decides an exact integration grant", async () => {
    requests = [readyIntegrationGrant];
    show();
    const card = await screen.findByRole("article", { name: readyIntegrationGrant.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_integration_grant_v6", {
      p_review_id: integrationReviewId, p_request_id: readyIntegrationGrant.id,
      p_approved: true,
    }));
  });

  it("holds an integration grant with a mismatched account", async () => {
    requests = [{ ...readyIntegrationGrant, account_ref: "another-account" }];
    show();
    const mismatched = await screen.findByRole("article", { name: readyIntegrationGrant.title });
    expect(within(mismatched).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("decides an exact metrics window before a manual provider pull queues", async () => {
    requests = [readyMetricsBackfill];
    show();
    const card = await screen.findByRole("article", { name: readyMetricsBackfill.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_metrics_backfill_review_v6", {
      p_review_id: backfillReviewId, p_request_id: readyMetricsBackfill.id,
      p_approved: true,
    }));
  });

  it("routes an exact creative authority change through the Inbox", async () => {
    requests = [readyCreativeRequirement];
    show();
    const card = await screen.findByRole("article", { name: readyCreativeRequirement.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_creative_requirement_v6", {
      p_review_id: creativeReviewId, p_request_id: readyCreativeRequirement.id,
      p_approved: true,
    }));
  });

  it("decides an exact client approval-seat assignment", async () => {
    requests = [readyClientAuthorityAssignment];
    show();
    const card = await screen.findByRole("article", { name: readyClientAuthorityAssignment.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_authority_assignment_v6", {
      p_review_id: authorityReviewId, p_request_id: readyClientAuthorityAssignment.id,
      p_approved: true,
    }));
  });

  it("holds a client approval-seat card with a different member destination", async () => {
    requests = [{ ...readyClientAuthorityAssignment,
      destination: "client:approval_seat:client-1:member-2" }];
    show();
    const card = await screen.findByRole("article", { name: readyClientAuthorityAssignment.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("decides an exact gateway tool only through its canonical Inbox card", async () => {
    requests = [readyGatewayTool];
    show();
    const card = await screen.findByRole("article", { name: readyGatewayTool.title });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_gateway_tool_review_v6", {
      p_approval_id: gatewayApprovalId, p_request_id: readyGatewayTool.id,
      p_approved: true,
    }));
  });

  it("holds a gateway card whose destination tool changed", async () => {
    requests = [{ ...readyGatewayTool,
      destination: "gateway:bot_production:workflow.create_task" }];
    show();
    const card = await screen.findByRole("article", { name: readyGatewayTool.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("shows gateway execution outcome and revokes an approved exact card with a reason", async () => {
    requests = [{ ...readyGatewayTool, status: "approved", source_state: "source_decided" }];
    gatewayOutcomes = [{ approval_id: gatewayApprovalId, execution_status: "completed",
      claimed_at: "2026-11-19T12:00:00Z", finished_at: "2026-11-19T12:01:00Z",
      sites_invocation_id: "sites-route-1", sites_invoked_at: "2026-11-19T12:00:30Z",
      result_hash: "f".repeat(64) }];
    show("client", `/approvals?source=${gatewayApprovalId}`);
    const card = await screen.findByRole("article", { name: readyGatewayTool.title });
    expect(within(card).getByText("Status: completed")).toBeInTheDocument();
    expect(within(card).getByText(/Sites adapter started:/)).toBeInTheDocument();
    expect(within(card).getByText(/not an external provider receipt/)).toBeInTheDocument();
    await userEvent.type(within(card).getByRole("textbox", { name: "Reason to revoke" }), "Operator stop");
    await userEvent.click(within(card).getByRole("button", { name: "Revoke with reason" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("revoke_gateway_tool_review_v6", {
      p_approval_id: gatewayApprovalId, p_request_id: readyGatewayTool.id, p_reason: "Operator stop",
    }));
  });

  it("holds revocation when an approved gateway destination changes", async () => {
    requests = [{ ...readyGatewayTool, status: "approved", source_state: "source_decided",
      destination: "gateway:bot_production:workflow.create_task" }];
    show("client", `/approvals?source=${gatewayApprovalId}`);
    const card = await screen.findByRole("article", { name: readyGatewayTool.title });
    expect(within(card).queryByRole("button", { name: "Revoke with reason" })).not.toBeInTheDocument();
  });

  it("unlocks ordinary creative approval only after downloading the exact stored file", async () => {
    requests = [readyOrdinaryMedia];
    show();
    const card = await screen.findByRole("article", { name: readyOrdinaryMedia.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/image.png", mediaFileHash,
    ));
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_ordinary_media_inbox_v6", {
      p_review_id: mediaReviewId, p_request_id: readyOrdinaryMedia.id,
    }));
  });

  it("downloads a generated single-file render rather than its source file", async () => {
    requests = [{ ...readyOrdinaryMedia, preview: {
      ...readyOrdinaryMedia.preview,
      asset: { ...readyOrdinaryMedia.preview.asset, render_path: "client-1/render.png" },
    } }];
    show();
    const card = await screen.findByRole("article", { name: readyOrdinaryMedia.title });
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/render.png", mediaFileHash,
    ));
  });

  it("requires every ordered carousel frame to match before source approval", async () => {
    const first = { frame_id: "frame-1", position: 1, caption: "Opening",
      storage_path: "client-1/image.png", file_sha256: mediaFileHash,
      file_bytes: 12, object_id: "storage-object-1", object_version: "v1",
      object_updated_at: "2026-11-19T00:00:00Z" };
    const second = { frame_id: "frame-2", position: 2, caption: "Close",
      storage_path: "client-1/image-2.png", file_sha256: "a".repeat(64),
      file_bytes: 15, object_id: "storage-object-2", object_version: null,
      object_updated_at: "2026-11-19T00:00:00Z" };
    requests = [{ ...readyOrdinaryMedia, preview: {
      ...readyOrdinaryMedia.preview,
      asset: { ...readyOrdinaryMedia.preview.asset, content_format: "carousel" },
      frames: [first, second],
    } }];
    downloadVerifiedCreativeFile.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Second frame bytes changed"));
    show();
    const card = await screen.findByRole("article", { name: readyOrdinaryMedia.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify every frame" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Second frame bytes changed");
    expect(approve).toBeDisabled();
    expect(downloadVerifiedCreativeFile).toHaveBeenNthCalledWith(1, first.storage_path, first.file_sha256);
    expect(downloadVerifiedCreativeFile).toHaveBeenNthCalledWith(2, second.storage_path, second.file_sha256);
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify every frame" }));
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_ordinary_media_inbox_v6", {
      p_review_id: mediaReviewId, p_request_id: readyOrdinaryMedia.id,
    }));
  });

  it("holds a framed creative card when its ordered frame packet is incomplete", async () => {
    requests = [{ ...readyOrdinaryMedia, preview: {
      ...readyOrdinaryMedia.preview,
      asset: { ...readyOrdinaryMedia.preview.asset, content_format: "story" },
      frames: [{ frame_id: "frame-2", position: 2, storage_path: "client-1/image.png",
        file_sha256: mediaFileHash, file_bytes: 12, object_id: "storage-object-1",
        object_version: "v1", object_updated_at: "2026-11-19T00:00:00Z" }],
    } }];
    show();
    const card = await screen.findByRole("article", { name: readyOrdinaryMedia.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("accepts a complete one-frame story packet", async () => {
    requests = [{ ...readyOrdinaryMedia, preview: {
      ...readyOrdinaryMedia.preview,
      asset: { ...readyOrdinaryMedia.preview.asset, content_format: "story" },
      frames: [{ frame_id: "frame-1", position: 1, caption: "Story",
        storage_path: "client-1/image.png", file_sha256: mediaFileHash,
        file_bytes: 12, object_id: "storage-object-1", object_version: "v1",
        object_updated_at: "2026-11-19T00:00:00Z" }],
    } }];
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    show();
    const card = await screen.findByRole("article", { name: readyOrdinaryMedia.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify every frame" }));
    await waitFor(() => expect(approve).toBeEnabled());
  });

  it("schedules an exact Engine slot only after the reviewer verifies its file", async () => {
    requests = [readyEngineSlot];
    show();
    const card = await screen.findByRole("article", { name: readyEngineSlot.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/image.png", mediaFileHash));
    await userEvent.click(approve);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_engine_slot_inbox_v6", {
      p_slot_id: engineSlotId, p_request_id: readyEngineSlot.id, p_approved: true,
    }));
  });

  it("verifies the finished Engine render instead of its source file", async () => {
    requests = [{ ...readyEngineSlot, preview: { exact_package: {
      ...readyEngineSlot.preview.exact_package,
      asset: { ...readyEngineSlot.preview.exact_package.asset,
        render_path: "client-1/finished.png" },
    } } }];
    show();
    const card = await screen.findByRole("article", { name: readyEngineSlot.title });
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith(
      "client-1/finished.png", mediaFileHash));
  });

  it("verifies every ordered Engine carousel frame before approval", async () => {
    const frames = [
      { frame_id: "engine-frame-1", position: 1, storage_path: "client-1/image.png",
        file_sha256: mediaFileHash, file_bytes: 12, object_id: "storage-object-1",
        object_version: "v1", object_updated_at: "2026-11-19T00:00:00Z" },
      { frame_id: "engine-frame-2", position: 2, storage_path: "client-1/second.png",
        file_sha256: "b".repeat(64), file_bytes: 16, object_id: "storage-object-2",
        object_version: "v1", object_updated_at: "2026-11-19T00:00:00Z" },
    ];
    requests = [{ ...readyEngineSlot, scope: { ...readyEngineSlot.scope, format: "carousel" },
      preview: { exact_package: { ...readyEngineSlot.preview.exact_package,
        slot: { ...readyEngineSlot.preview.exact_package.slot, format: "carousel" },
        asset: { ...readyEngineSlot.preview.exact_package.asset, content_format: "carousel" },
        frames,
      } } }];
    show();
    const card = await screen.findByRole("article", { name: readyEngineSlot.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify every frame" }));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(downloadVerifiedCreativeFile).toHaveBeenNthCalledWith(1, frames[0].storage_path, frames[0].file_sha256);
    expect(downloadVerifiedCreativeFile).toHaveBeenNthCalledWith(2, frames[1].storage_path, frames[1].file_sha256);
  });

  it("reviews a finished Engine reel only with exact video seats", async () => {
    const seats = { owner_user_id: "video-owner", manager_user_id: "video-manager",
      client_user_id: null, signoffs: [
        { role: "owner", user_id: "video-owner", request_id: "owner-request",
          content_hash: "a".repeat(64) },
        { role: "manager", user_id: "video-manager", request_id: "manager-request",
          content_hash: "b".repeat(64) },
      ] };
    const reel = { ...readyEngineSlot, scope: { ...readyEngineSlot.scope, format: "reel" },
      preview: { exact_package: { ...readyEngineSlot.preview.exact_package,
        slot: { ...readyEngineSlot.preview.exact_package.slot, format: "reel" },
        asset: { ...readyEngineSlot.preview.exact_package.asset,
          media_type: "video", content_format: "reel", edit_stage: "review_ready",
          render_path: "client-1/finished-reel.mp4" },
        video_seats: seats,
      } } };
    requests = [{ ...reel, preview: { exact_package: {
      ...reel.preview.exact_package,
      video_seats: { ...seats, signoffs: seats.signoffs.slice(0, 1) },
    } } }];
    const firstView = show();
    let card = await screen.findByRole("article", { name: readyEngineSlot.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    firstView.unmount();
    requests = [{ ...reel, preview: { exact_package: {
      ...reel.preview.exact_package,
      video_seats: { ...seats, manager_user_id: "reassigned-manager" },
    } } }];
    const mismatchedView = show();
    card = await screen.findByRole("article", { name: readyEngineSlot.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    mismatchedView.unmount();
    requests = [reel];
    show();
    card = await screen.findByRole("article", { name: readyEngineSlot.title });
    const approve = within(card).getByRole("button", { name: "Approve exact version" });
    expect(approve).toBeDisabled();
    downloadVerifiedCreativeFile.mockResolvedValue(undefined);
    await userEvent.click(within(card).getByRole("button", { name: "Download and verify creative file" }));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(downloadVerifiedCreativeFile).toHaveBeenCalledWith("client-1/finished-reel.mp4", mediaFileHash);
  });

  it("rejects an offer with a reason", async () => {
    const user = userEvent.setup();
    requests = [readyOffer];
    show();
    const card = await screen.findByRole("article", { name: readyOffer.title });
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Claim unsupported");
    await user.click(within(card).getByRole("button", { name: "Reject with reason" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("reject_service_offer_version_v6", {
      p_version_id: offerVersionId, p_reason: "Claim unsupported",
    }));
  });

  it("does not decide an offer when its exact inbox scope changes before the click", async () => {
    const user = userEvent.setup();
    requests = [readyOffer];
    freshRequest = { ...readyOffer, scope: { ...readyOffer.scope, version: 2 } };
    show();
    const card = await screen.findByRole("article", { name: readyOffer.title });
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/exact request changed/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps a held offer approval unavailable while allowing a reasoned rejection", async () => {
    const user = userEvent.setup();
    requests = [{ ...readyOffer, status: "source_held", source_state: "source_held" }];
    show();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    const card = await screen.findByRole("article", { name: readyOffer.title });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Reject with reason" })).toBeDisabled();
  });

  it("requires a reason and fresh AAL2 for campaign rejection", async () => {
    const user = userEvent.setup();
    requests = [readyCampaign];
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    const reject = within(card).getByRole("button", { name: "Reject with reason" });
    expect(reject).toBeDisabled();
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Wrong account");
    expect(reject).toBeEnabled();
    await user.click(reject);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
      p_request_id: "action-1", p_decision: "rejected", p_reason: "Wrong account",
    }));
    expect(getAAL.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("disables decisions without AAL2", async () => {
    requests = [readyCampaign];
    getAAL.mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(await within(card).findByText(/Complete MFA to reach AAL2/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Approve exact version" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechecks AAL2 at click time before reading or deciding", async () => {
    const user = userEvent.setup();
    requests = [readyCampaign];
    getAAL.mockResolvedValueOnce({ data: { currentLevel: "aal2" }, error: null })
      .mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Complete MFA to reach AAL2/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechecks the exact canonical version before calling the owning RPC", async () => {
    const user = userEvent.setup();
    requests = [readyCampaign];
    freshRequest = { ...readyCampaign, artifact_hash: "b".repeat(64) };
    show();
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("offers no decision on blocked or already decided cards and only rejection after expiry", async () => {
    const user = userEvent.setup();
    requests = [
      { ...readyCampaign, id: "blocked", preview_blocker: "Missing exact creative" },
      { ...readyCampaign, id: "empty", title: "Empty preview", preview: {} },
      { ...readyCampaign, id: "expired", title: "Expired action", status: "expired",
        expires_at: "2020-01-01T00:00:00Z" },
      { ...readyCampaign, id: "decided", title: "Decided action", status: "approved" },
    ];
    show();
    await screen.findByText("Build the Meta ad");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    expect(screen.queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Build the Meta ad" }))
      .queryByRole("button", { name: "Reject with reason" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Empty preview" }))
      .queryByRole("button", { name: "Reject with reason" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Decided action" }))
      .queryByRole("button", { name: "Reject with reason" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Expired action" }))
      .getByRole("button", { name: "Reject with reason" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("can close an expired complete campaign request with a reasoned rejection", async () => {
    const user = userEvent.setup();
    requests = [{ ...readyCampaign, status: "expired", expires_at: "2020-01-01T00:00:00Z" }];
    show();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "expired");
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Approval window closed");
    await user.click(within(card).getByRole("button", { name: "Reject with reason" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
      p_request_id: "action-1", p_decision: "rejected", p_reason: "Approval window closed",
    }));
  });

  it("decides a complete Google reply through the version-bound owning wrapper", async () => {
    const user = userEvent.setup();
    requests = [readyGoogle];
    rpc.mockImplementation(async () => {
      requests = [{ ...readyGoogle, status: "approved" }];
      decisions = [{ request_id: readyGoogle.id, decision: "approved", actor_id: "human-1",
        actor_aal: "aal2", reason: null, decided_at: "2026-10-30T09:00:00Z" }];
      return { data: null, error: null };
    });
    show();
    const card = await screen.findByRole("article", { name: "Google review reply: Harbour Home" });
    expect(within(card).getByText("Google review reply decision")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_google_review_reply_from_inbox_v6", {
      p_reply_id: "reply-1", p_expected_source_version: "b".repeat(64),
      p_expected_artifact_hash: "b".repeat(64), p_approved: true,
    }));
    await waitFor(() => expect(screen.getByText("Decision history (1)")).toBeInTheDocument());
    expect(rpc).not.toHaveBeenCalledWith("decide_google_review_reply_v6", expect.anything());
  });

  it("decides a recruitment brief only with the selected full Inbox card", async () => {
    const user = userEvent.setup();
    requests = [readyRecruitment];
    rpc.mockImplementation(async () => {
      requests = [{ ...readyRecruitment, status: "approved" }];
      decisions = [{ request_id: readyRecruitment.id, decision: "approved", actor_id: "human-1",
        actor_aal: "aal2", reason: null, decided_at: "2026-10-30T09:00:00Z" }];
      return { data: null, error: null };
    });
    show("global", "/approvals?source=brief-1");
    const card = await screen.findByRole("article", { name: "Recruitment brief: Editor" });
    expect(within(card).getByText(/Join the editing team/)).toBeInTheDocument();
    expect(within(card).getByText("Recruitment brief decision")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject with reason" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search current page" })).toHaveValue("brief-1");
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_recruitment_brief_from_inbox_v6", {
      p_brief_id: "brief-1", p_request_id: "recruitment-request-1",
      p_expected_source_version: `${"d".repeat(64)}:v1`,
      p_expected_artifact_hash: "d".repeat(64),
    }));
    expect(rpc).not.toHaveBeenCalledWith("approve_recruitment_brief", expect.anything());
  });

  it("keeps blocked and changed recruitment cards read-only or rejects the click", async () => {
    const user = userEvent.setup();
    requests = [
      { ...readyRecruitment, id: "blocked", preview_blocker: "Incomplete brief" },
      { ...readyRecruitment, id: "stale", title: "Edited brief" },
    ];
    freshRequest = { ...readyRecruitment, id: "stale", source_version: `${"e".repeat(64)}:v2`,
      artifact_hash: "e".repeat(64) };
    show("global");
    const stale = await screen.findByRole("article", { name: "Edited brief" });
    expect(within(screen.getByRole("article", { name: "Recruitment brief: Editor" }))
      .queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    await user.click(within(stale).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires a reason and passes the selected Google version on rejection", async () => {
    const user = userEvent.setup();
    requests = [readyGoogle];
    show();
    const card = await screen.findByRole("article", { name: "Google review reply: Harbour Home" });
    const reject = within(card).getByRole("button", { name: "Reject with reason" });
    expect(reject).toBeDisabled();
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Wrong response");
    await user.click(reject);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_google_review_reply_from_inbox_v6", {
      p_reply_id: "reply-1", p_expected_source_version: "b".repeat(64),
      p_expected_artifact_hash: "b".repeat(64), p_approved: false,
      p_reason: "Wrong response",
    }));
  });

  it("keeps blocked, incomplete and stale Google cards read-only or rejects their click", async () => {
    requests = [
      { ...readyGoogle, id: "blocked", preview_blocker: "Google review is gone" },
      { ...readyGoogle, id: "missing-target", title: "No Google destination", destination: null },
      { ...readyGoogle, id: "stale", title: "Edited Google reply" },
    ];
    freshRequest = { ...readyGoogle, id: "stale", source_version: "d".repeat(64),
      artifact_hash: "d".repeat(64) };
    show();
    const user = userEvent.setup();
    const stale = await screen.findByRole("article", { name: "Edited Google reply" });
    expect(within(screen.getByRole("article", { name: "Google review reply: Harbour Home" }))
      .queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "No Google destination" }))
      .queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    await user.click(within(stale).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("disables Google reply decisions unless current assurance is AAL2", async () => {
    requests = [readyGoogle];
    getAAL.mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
    show();
    const card = await screen.findByRole("article", { name: "Google review reply: Harbour Home" });
    expect(await within(card).findByRole("button", { name: "Approve exact version" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows exact sales scope and decides a staged grant through its AAL2 owning RPC", async () => {
    const user = userEvent.setup();
    requests = [readySales];
    rpc.mockImplementation(async () => {
      requests = [{ ...readySales, status: "approved", source_state: "source_decided" }];
      decisions = [{ request_id: readySales.id, decision: "approved", actor_id: "admin-1",
        actor_aal: "aal2", reason: "Approved from unified Approval Inbox",
        decided_at: "2026-10-30T09:00:00Z" }];
      return { data: null, error: null };
    });
    show("global");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    expect(within(card).getByText(/Employee One/)).toBeInTheDocument();
    expect(within(card).getAllByText(/member-1/)).toHaveLength(2);
    expect(within(card).getByText(/Before enabling access, audit every approved, unrevoked grant/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open sales access requests" }))
      .toHaveAttribute("href", "/clients/client-1/delivery/sales-os?tab=leads");
    await user.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_sales_entitlement", {
      p_request_id: salesRequestId, p_scope_hash: salesHash,
      p_approve: true, p_note: "Approved from unified Approval Inbox",
    }));
    await waitFor(() => expect(screen.getByText("Decision history (1)")).toBeInTheDocument());
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
  });

  it("routes a canonical archived-contact card to its source-owned AAL2 review", async () => {
    requests = [{ ...request,
      id: "archived-return-card", source_system: "aa_console",
      source_kind: "archived_form_return", source_id: "form-return-1",
      source_version: "c".repeat(64), artifact_hash: "c".repeat(64),
      title: "Review returning form contact", source_state: "pending",
      expires_at: "2030-01-01T00:00:00Z",
      preview: { archived_lead_id: "archived-1", source_hash: "c".repeat(64) },
      scope: { client_id: "client-1", effect: "lead_identity_resolution" },
      destination: "internal:lead_identity", owner_role: "client_lead_reviewer",
      owning_path: "/clients/client-1/delivery/sales-os?tab=capture",
    }];
    show();
    const card = await screen.findByRole("article", { name: "Review returning form contact" });
    expect(within(card).getByRole("link", { name: "View owning source" }))
      .toHaveAttribute("href", "/clients/client-1/delivery/sales-os?tab=capture");
    expect(within(card).queryByRole("button", { name: "Approve exact version" }))
      .not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject exact version" }))
      .not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the exact sales revoke source and requires a reason for rejection", async () => {
    const user = userEvent.setup();
    requests = [readySalesRevoke];
    show("global");
    const card = await screen.findByRole("article", { name: "Revoke sales access" });
    expect(within(card).getByText("Sales access decision")).toBeInTheDocument();
    const reject = within(card).getByRole("button", { name: "Reject with reason" });
    expect(reject).toBeDisabled();
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), " Wrong account ");
    await user.click(reject);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_sales_entitlement", {
      p_request_id: readySalesRevoke.source_id, p_scope_hash: salesHash,
      p_approve: false, p_note: "Wrong account",
    }));
  });

  it("closes an expired sales request by rejection and never offers approval", async () => {
    const user = userEvent.setup();
    requests = [{ ...readySales, status: "expired", expires_at: "2020-01-01T00:00:00Z" }];
    show("global");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "expired");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Window closed");
    await user.click(within(card).getByRole("button", { name: "Reject with reason" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_sales_entitlement", {
      p_request_id: salesRequestId, p_scope_hash: salesHash,
      p_approve: false, p_note: "Window closed",
    }));
  });

  it("offers only reasoned rejection when the live sales target becomes held", async () => {
    const user = userEvent.setup();
    requests = [{ ...readySales, status: "source_held", source_state: "source_held" }];
    show("global");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "source_held");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    expect(within(card).getAllByText(/only be closed with a reasoned rejection/)).toHaveLength(2);
    await user.type(within(card).getByRole("textbox", { name: "Reason to reject" }), "Employee account relinked");
    await user.click(within(card).getByRole("button", { name: "Reject with reason" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_client_sales_entitlement", {
      p_request_id: salesRequestId, p_scope_hash: salesHash,
      p_approve: false, p_note: "Employee account relinked",
    }));
  });

  it("shows a stale source and blocks its exact-version approval", async () => {
    const user = userEvent.setup();
    requests = [{ ...readyCampaign, status: "stale",
      preview_blocker: "A bound source changed after this exact request." }];
    show("global");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "stale");
    const card = await screen.findByRole("article", { name: "Build the Meta ad" });
    expect(within(card).getByText("stale")).toBeInTheDocument();
    expect(within(card).getByText(/A bound source changed/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Approve exact version" }))
      .not.toBeInTheDocument();
  });

  it("keeps sales grants read-only for managers and malformed or superseded scopes", async () => {
    requests = [readySales];
    show("manager", "/employee/approvals");
    expect(await screen.findByRole("heading", { name: "Manager approval inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Grant sales access" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("renders an incomplete sales card without hiding another valid decision", async () => {
    requests = [{ ...readySales, id: "sales-incomplete", preview: null }, readySales];
    show("global");
    expect(await screen.findAllByRole("article", { name: "Grant sales access" })).toHaveLength(2);
    // Both rows share a title; locate the blocked row by its projection ID.
    const blocked = document.getElementById("approval-sales-incomplete")?.closest("article");
    expect(blocked).toBeInTheDocument();
    expect(within(blocked as HTMLElement).getByText(/exact artifact preview is missing/i)).toBeInTheDocument();
    expect(within(blocked as HTMLElement).queryByRole("button", { name: "Approve exact version" }))
      .not.toBeInTheDocument();
    const valid = document.getElementById("approval-sales-inbox-1")?.closest("article");
    expect(valid).toBeInTheDocument();
    expect(within(valid as HTMLElement).getByRole("button", { name: "Approve exact version" }))
      .toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", { owner_role: "admin_or_active_client_manager" }],
    ["changed artifact", { artifact_hash: "e".repeat(64) }],
    ["changed scope", { scope: { ...readySales.scope, member_id: "member-2" } }],
    ["changed destination", { destination: "client_sales_os:another-client" }],
    ["changed account", { account_ref: "employee-2" }],
    ["changed action", { preview: { ...readySales.preview, action: "revoke" } }],
    ["missing frozen name", { preview: { ...readySales.preview, member_name: "" } }],
    ["no human origin", { requester_kind: "service", requested_by: null }],
    ["source decided", { status: "source_decided", source_state: "source_decided" }],
  ])("keeps a sales card read-only with %s", async (_label, change) => {
    requests = [{ ...readySales, ...change }];
    show("global");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    const card = await screen.findByRole("article");
    expect(within(card).queryByRole("button", { name: "Approve exact version" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject with reason" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechecks AAL2 and a fresh exact sales card before calling the source", async () => {
    requests = [readySales];
    getAAL.mockResolvedValueOnce({ data: { currentLevel: "aal2" }, error: null })
      .mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
    show("global");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Complete MFA to reach AAL2/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a sales scope change between render and click", async () => {
    requests = [readySales];
    freshRequest = { ...readySales, scope: { ...readySales.scope, member_id: "member-2" } };
    show("global");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["requester", { requested_by: "admin-2" }],
    ["request timestamp", { requested_at: "2026-10-30T08:00:01Z" }],
    ["title", { title: "Revoke sales access" }],
  ])("rejects a %s change between render and click", async (_label, change) => {
    requests = [readySales];
    freshRequest = { ...readySales, ...change };
    show("global");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces a rejected sales source RPC without claiming a decision", async () => {
    requests = [readySales];
    rpc.mockResolvedValue({ data: null, error: { message: "The team member identity changed." } });
    show("global");
    const card = await screen.findByRole("article", { name: "Grant sales access" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The team member identity changed.");
    expect(await within(await screen.findByRole("article", { name: "Grant sales access" }))
      .findByRole("button", { name: "Approve exact version" })).toBeInTheDocument();
  });

  it("shows every client and the house client in the admin global Inbox with safe source links", async () => {
    requests = [
      { ...request, id: "first", title: "First client", client_id: "client-1",
        owning_path: "/clients/client-1/delivery/approval-inbox?tab=assets" },
      { ...request, id: "second", title: "Second client", client_id: "client-2",
        owning_path: "/clients/client-2/google-profile?tab=reviews" },
      { ...request, id: "wrong-link", title: "Wrong client route", client_id: "client-2",
        owning_path: "/clients/client-1/google-profile?tab=reviews" },
      { ...request, id: "house", title: "House recruitment", client_id: "house-client",
        source_system: "aa_console", source_kind: "recruitment_brief",
        owning_path: "/team?tab=recruitment" },
    ];
    show("global");
    expect(await screen.findByRole("heading", { name: "Agency approval inbox" })).toBeInTheDocument();
    expect(clientEqValues).toHaveLength(0);
    expect(screen.getByText("Page 1: showing 4 of 4 loaded requests.")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Second client" }))
      .getByRole("link", { name: "View owning source" }))
      .toHaveAttribute("href", "/clients/client-2/google-profile?tab=reviews");
    expect(within(screen.getByRole("article", { name: "Wrong client route" }))
      .queryByRole("link", { name: "View owning source" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "House recruitment" }))
      .getByRole("link", { name: "View owning source" }))
      .toHaveAttribute("href", "/team?tab=recruitment");
    await userEvent.type(screen.getByLabelText("Client ID"), "client-2");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("Second client")).toBeInTheDocument();
    expect(screen.queryByText("House recruitment")).not.toBeInTheDocument();
  });

  it("uses a global card's own client for a fresh exact-version decision read", async () => {
    requests = [{ ...readyGoogle, client_id: "client-2",
      scope: { ...readyGoogle.scope, client_id: "client-2" },
      owning_path: "/clients/client-2/google-profile?tab=reviews" }];
    show("global");
    const card = await screen.findByRole("article", { name: "Google review reply: Harbour Home" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(clientEqValues).toContain("client-2"));
    expect(rpc).toHaveBeenCalledWith("decide_google_review_reply_from_inbox_v6", expect.anything());
  });
});
