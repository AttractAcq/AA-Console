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

function wireDatabase() {
  from.mockImplementation((table: string) => {
    let id: string | null = null;
    const query = {
      select: () => query,
      eq: (column: string, value: string) => {
        if (column === "id") id = value;
        return query;
      },
      in: () => query,
      maybeSingle: async () => ({
        data: freshRequest === undefined ? requests.find((row) => (row as { id: string }).id === id) ?? null : freshRequest,
        error: requestError,
      }),
      order: async () => table === "approval_inbox_v6"
        ? { data: requests, error: requestError }
        : { data: decisions, error: decisionError },
    };
    return query;
  });
}

function show() {
  return render(<MemoryRouter><UnifiedApprovalInboxPanel /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  requests = [request];
  decisions = [];
  requestError = null;
  decisionError = null;
  freshRequest = undefined;
  getAAL.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
  rpc.mockResolvedValue({ data: null, error: null });
  wireDatabase();
});

describe("unified approval inbox", () => {
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
    expect(within(card).getByRole("link", { name: "View owning source" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/approval-inbox?tab=campaign-actions",
    );
    expect(within(card).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(from).toHaveBeenCalledWith("approval_inbox_v6");
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
    for (const title of ["Other team card", "Cross-client brief", "Other team tab"]) {
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Source type" }), "campaign_action");
    expect(screen.getByText("No requests match these filters.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    expect(screen.getByText("Build the Meta ad")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "no match");
    expect(screen.getByText("No requests match these filters.")).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/exact request changed/);
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
});
