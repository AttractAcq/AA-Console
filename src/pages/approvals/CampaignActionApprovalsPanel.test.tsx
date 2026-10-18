import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { CampaignActionApprovalsPanel } from "./CampaignActionApprovalsPanel";

const pending = {
  id: "approval-1", client_id: "client-1", campaign_id: "campaign-1",
  manifest_id: "manifest-1", action_key: "meta_ad_build",
  destination: "meta:act_123", artifact_version_hash: "a".repeat(32),
  scope: { daily_spend_limit: 50 }, status: "pending",
};

beforeEach(() => {
  vi.clearAllMocks();
  let records = [pending];
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => Promise.resolve({ data: records, error: null }),
    };
    return query;
  });
  rpc.mockImplementation(async () => {
    records = [];
    return { error: null };
  });
});

it("shows the exact destination and scope before a human approves", async () => {
  const user = userEvent.setup();
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText("meta:act_123", { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/daily_spend_limit/)).toBeInTheDocument();
  expect(screen.getByText("a".repeat(32))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Approve this scope" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("decide_campaign_action_approval_v6", {
    // An approval carries no reason: the key is left out so the function's
    // own default applies, which is the same null it used to be sent.
    p_request_id: "approval-1", p_decision: "approved",
  }));
  expect(await screen.findByText("No campaign action requests are waiting.")).toBeInTheDocument();
});

it("requires the frozen page HTML before allowing page deployment approval", async () => {
  const pageRequest = { ...pending, action_key: "page_deploy",
    destination: "https://sites.example/offer/" };
  from.mockImplementation((table: string) => {
    if (table === "campaign_page_approval_snapshots") {
      return { select: () => ({ in: async () => ({ data: [{
        approval_id: "approval-1", rendered_html: "<html><body>Exact offer</body></html>",
      }], error: null }) }) };
    }
    const query = { select: () => query, eq: () => query,
      order: async () => ({ data: [pageRequest], error: null }) };
    return query;
  });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByTitle("Page revision for https://sites.example/offer/"))
    .toHaveAttribute("sandbox", "");
  expect(screen.getByText(/Exact offer/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve this scope" })).toBeEnabled();
});

it("refuses a page approval with no reviewable snapshot", async () => {
  const pageRequest = { ...pending, action_key: "page_deploy" };
  from.mockImplementation((table: string) => {
    if (table === "campaign_page_approval_snapshots") {
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
    }
    const query = { select: () => query, eq: () => query,
      order: async () => ({ data: [pageRequest], error: null }) };
    return query;
  });
  render(<CampaignActionApprovalsPanel />);
  expect(await screen.findByText(/No reviewable page snapshot is attached/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve this scope" })).toBeDisabled();
});
