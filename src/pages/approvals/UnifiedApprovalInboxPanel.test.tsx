import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, getAAL, downloadVerifiedProofFile } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), getAAL: vi.fn(), downloadVerifiedProofFile: vi.fn(),
}));
vi.mock("../../lib/proofRights", () => ({ downloadVerifiedProofFile }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from, rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: getAAL } },
} }));
vi.mock("./ApprovalCoveragePanel", () => ({ ApprovalCoveragePanel: () => null }));
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
let requestError: { message: string } | null;
let decisionError: { message: string } | null;
let freshRequest: unknown | undefined;
let clientEqValues: string[];
let requestRanges: Array<[number, number]>;
let historyIds: string[][];

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
      in: (_column: string, ids: string[]) => { historyIds.push(ids); return query; },
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
  requests = [request];
  decisions = [];
  requestError = null;
  decisionError = null;
  freshRequest = undefined;
  clientEqValues = [];
  requestRanges = [];
  historyIds = [];
  getAAL.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
  rpc.mockResolvedValue({ data: null, error: null });
  wireDatabase();
});

describe("unified approval inbox", () => {
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
