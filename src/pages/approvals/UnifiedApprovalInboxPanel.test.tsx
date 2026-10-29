import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
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

function wireDatabase() {
  from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
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
});
