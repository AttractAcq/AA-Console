import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map([["hiring/ad.png", "https://signed.example/ad.png"]]) }));

import { RecruitmentDistributionPanel } from "./RecruitmentDistributionPanel";

function chain(data: unknown, single: unknown = null) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) query[method] = () => query;
  query.maybeSingle = () => Promise.resolve({ data: single, error: null });
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === "aa_house_client_id" ? "house-1" : "campaign-1", error: null }));
  from.mockImplementation((table: string) => {
    if (table === "client_integrations") return chain(null, {
      status: "connected", ad_account_id: "act_123", meta_page_id: "456", meta_pixel_id: "789",
    });
    if (table === "client_media_assets") return chain([{
      id: "asset-1", brief_id: "brief-1", title: "Editor image", media_type: "image",
      content_format: "single", storage_path: "hiring/ad.png",
    }]);
    if (table === "client_briefs") return chain([{
      id: "brief-1", title: "Editor", recruitment_role: "editor", hook: "Join AA",
      script: "We're hiring", apply_url: "https://example.com/apply", call_to_action: "APPLY_NOW",
    }]);
    return chain([]);
  });
});

it("selects approved AA ads and records a held Inbox request without promising a Meta build", async () => {
  render(<RecruitmentDistributionPanel />);
  expect(await screen.findByText(/Connected: act_123/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Campaign name" }), { target: { value: "Editor hiring" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Daily budget" }), { target: { value: "25" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Countries" }), { target: { value: "za, gb" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Editor image/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save campaign and request Inbox review" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_recruitment_meta_campaign", {
    p_name: "Editor hiring", p_daily_budget: 25,
    p_target_countries: ["ZA", "GB"], p_asset_ids: ["asset-1"],
  }));
  expect(await screen.findByRole("status")).toHaveTextContent(/No Meta objects were created/i);
  expect(screen.getByRole("link", { name: "Open Approval Inbox" })).toHaveAttribute("href", "/approvals");
});

it("allows a held request while the Meta account still needs connection", async () => {
  const base = from.getMockImplementation()!;
  from.mockImplementation((table: string) => table === "client_integrations"
    ? chain(null, null) : base(table));
  render(<RecruitmentDistributionPanel />);
  expect(await screen.findByText(/You can still prepare a held request/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save campaign and request Inbox review" }))
    .toBeEnabled();
});

it("flags a historical partial provider write for assisted reconciliation", async () => {
  const base = from.getMockImplementation()!;
  from.mockImplementation((table: string) => table === "recruitment_meta_campaigns"
    ? chain([{
      id: "campaign-legacy", name: "Legacy hiring", daily_budget: 25,
      target_countries: ["ZA"], meta_campaign_id: "provider-campaign-1",
      meta_ad_set_id: null, meta_built_at: null, created_at: "2026-10-01T00:00:00Z",
    }]) : base(table));
  render(<RecruitmentDistributionPanel />);
  expect(await screen.findByText(/Partial Meta objects may exist; reconcile in Ads Manager/))
    .toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open in Ads Manager" })).toBeInTheDocument();
});

// If migration 133 is missing during a rollout, the approved ads and Meta
// account status remain useful even while campaign requests are unavailable.
describe("when migration 133 has not been applied", () => {
  const MISSING_TABLE = {
    code: "PGRST205",
    message: "Could not find the table 'public.recruitment_meta_campaigns' in the schema cache",
  };

  function chainError(error: { code: string; message: string }) {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) query[method] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: null, error });
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: null, error }).then(resolve, reject);
    return query;
  }

  function withCampaignsError(error: { code: string; message: string }) {
    const base = from.getMockImplementation()!;
    from.mockImplementation((table: string) =>
      table === "recruitment_meta_campaigns" ? chainError(error) : base(table));
  }

  it("keeps the approved ads visible and names the reason", async () => {
    withCampaignsError(MISSING_TABLE);
    render(<RecruitmentDistributionPanel />);

    expect(await screen.findByText(/Recruitment campaign requests are unavailable/)).toBeInTheDocument();
    // The ad list reads client_media_assets, which exists. Before the guard the
    // whole panel collapsed into one error and showed none of this.
    expect(screen.getByText("Editor image")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables a request when its source table is unavailable", async () => {
    withCampaignsError(MISSING_TABLE);
    render(<RecruitmentDistributionPanel />);
    await screen.findByText(/Recruitment campaign requests are unavailable/);

    expect(screen.getByRole("button", { name: /Save campaign and request Inbox review/ })).toBeDisabled();
    expect(screen.getByText(/cannot be listed yet/)).toBeInTheDocument();
    expect(screen.queryByText("No recruitment campaigns prepared yet.")).toBeNull();
  });

  it("still reports a real failure on that table as an error", async () => {
    withCampaignsError({ code: "42501", message: "permission denied for table recruitment_meta_campaigns" });
    render(<RecruitmentDistributionPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission denied/);
    expect(screen.queryByText(/Recruitment campaign requests are unavailable/)).toBeNull();
  });
});
