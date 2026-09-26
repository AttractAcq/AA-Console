import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

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

it("selects approved AA ads and queues a paused house-account campaign", async () => {
  render(<RecruitmentDistributionPanel />);
  expect(await screen.findByText(/Connected: act_123/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Campaign name" }), { target: { value: "Editor hiring" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Daily budget" }), { target: { value: "25" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Countries" }), { target: { value: "za, gb" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Editor image/ }));
  fireEvent.click(screen.getByRole("button", { name: "Push selected ads to Ads Manager" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_recruitment_meta_campaign", {
    p_name: "Editor hiring", p_daily_budget: 25,
    p_target_countries: ["ZA", "GB"], p_asset_ids: ["asset-1"],
  }));
  expect(await screen.findByRole("status")).toHaveTextContent(/paused campaign/i);
});
