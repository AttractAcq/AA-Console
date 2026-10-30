import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, getAAL } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), getAAL: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from, rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: getAAL } },
} }));
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

const invitationSourceId = "11111111-1111-4111-8111-111111111111";
const invitationHash = "e".repeat(64);
const readyInvitation = {
  ...request,
  id: "33333333-3333-4333-8333-333333333333", client_id: null,
  source_system: "auth", source_kind: "console_invitation",
  source_id: invitationSourceId, source_version: invitationHash,
  artifact_hash: invitationHash, title: "Invite New Editor",
  expires_at: "2035-01-01T00:00:00Z", destination: "new@example.com",
  account_ref: "auth@attractacq.com", budget: null,
  preview: {
    recipient_email: "new@example.com", sender_account: "auth@attractacq.com",
    target_role: "employee", target_member_id: "22222222-2222-4222-8222-222222222222",
    target_client_id: null, team_category: "editors", team_member_generation: 0,
    full_name: "New Editor", redirect_origin: "https://console.attractacq.com",
    redirect_url: `https://console.attractacq.com/invite/accept?request=${invitationSourceId}`,
    auth_project_origin: "https://project.supabase.co",
    sender_verification_id: "44444444-4444-4444-8444-444444444444",
    smtp_evidence_sha256: "b".repeat(64), template_subject: "Your AA Console invitation",
    template_body: "Use this invitation link.", template_sha256: "c".repeat(64),
    expires_at: "2035-01-01T00:00:00Z",
  },
  scope: { target_role: "employee", target_member_id: "22222222-2222-4222-8222-222222222222",
    target_client_id: null },
  owner_role: "admin", owning_path: "/approvals",
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Source type" }), "campaign_action");
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

  it("decides an exact agency invitation in the global Inbox through its owning RPC", async () => {
    requests = [readyInvitation];
    rpc.mockImplementation(async () => {
      requests = [{ ...readyInvitation, status: "approved", source_state: "source_decided" }];
      decisions = [{ request_id: readyInvitation.id, decision: "approved", actor_id: "human-1",
        actor_aal: "aal2", reason: null, decided_at: "2026-10-30T09:00:00Z" }];
      return { data: null, error: null };
    });
    show("global");
    const card = await screen.findByRole("article", { name: "Invite New Editor" });
    expect(within(card).getByText("Auth invitation decision")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_console_invitation_v6", {
      p_request_id: invitationSourceId,
      p_expected_source_version: invitationHash,
      p_expected_artifact_hash: invitationHash,
      p_approved: true,
    }));
    expect(await screen.findByText("Decision history (1)")).toBeInTheDocument();
  });

  it("keeps agency invitation decisions out of the client Inbox", async () => {
    requests = [readyInvitation];
    show("client");
    await waitFor(() => expect(screen.queryByRole("article", { name: "Invite New Editor" }))
      .not.toBeInTheDocument());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("re-reads the exact invitation preview before recording a decision", async () => {
    requests = [readyInvitation];
    freshRequest = { ...readyInvitation,
      preview: { ...readyInvitation.preview, template_body: "Changed body" } };
    show("global");
    const card = await screen.findByRole("article", { name: "Invite New Editor" });
    await userEvent.click(within(card).getByRole("button", { name: "Approve exact version" }));
    expect(await screen.findByText(/This exact request changed or is no longer pending/))
      .toHaveAttribute("role", "alert");
    expect(rpc).not.toHaveBeenCalled();
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Client" }), "client-2");
    expect(screen.getByText("Second client")).toBeInTheDocument();
    expect(screen.queryByText("House recruitment")).not.toBeInTheDocument();
  });

  it("shows a held agency-wide release card by default without decision controls", async () => {
    requests = [{ ...request, id: "release-1", client_id: null,
      source_system: "aa_console", source_kind: "production_release", title: "Production release PR #271",
      status: "source_held", source_state: "source_held",
      preview_blocker: "Release checks and deployment are not independently attested." }];
    show("global");
    const card = await screen.findByRole("article", { name: "Production release PR #271" });
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");
    expect(within(card).getByText("Agency-wide")).toBeInTheDocument();
    expect(within(card).getAllByRole("alert")[0]).toHaveTextContent("not independently attested");
    expect(within(card).queryByRole("button", { name: "Approve exact version" }))
      .not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Reject with reason" }))
      .not.toBeInTheDocument();
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
