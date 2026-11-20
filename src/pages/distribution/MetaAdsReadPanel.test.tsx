import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, enqueueAgentJob } = vi.hoisted(() => ({ from: vi.fn(), enqueueAgentJob: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from }, enqueueAgentJob }));
import { MetaAdsReadPanel } from "./MetaAdsReadPanel";

let runs: unknown[];
let campaigns: unknown[];
let ads: unknown[];
let matches: unknown[];
let integration: unknown;
beforeEach(() => {
  vi.clearAllMocks();
  runs = []; campaigns = []; ads = []; matches = [];
  integration = { id: "integration-1", ad_account_id: "act_123", credential_secret_id: "secret-1" };
  enqueueAgentJob.mockResolvedValue("job-1");
  from.mockImplementation((table: string) => {
    const data = table === "meta_ads_read_runs_v7" ? runs
      : table === "meta_ads_campaign_reads_v7" ? campaigns
      : table === "meta_ads_ad_reads_v7" ? ads : matches;
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain, order: () => chain,
      limit: async () => ({ data, error: null }),
      maybeSingle: async () => ({ data: integration, error: null }) });
    return chain;
  });
});

describe("Meta Ads account view", () => {
  it("shows the shared account snapshot without a queue action in profile mode", async () => {
    render(<MetaAdsReadPanel clientId="client-1" readOnly />);
    expect(await screen.findByText(/Inventory and metrics are unknown/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read Meta Ads account" })).not.toBeInTheDocument();
    expect(enqueueAgentJob).not.toHaveBeenCalled();
  });
  it("shows unknown data and queues only a read job", async () => {
    render(<MetaAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/Inventory and metrics are unknown/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read Meta Ads account" }));
    expect(enqueueAgentJob).toHaveBeenCalledWith({ agentKey: "meta_ads_read", clientId: "client-1" });
  });

  it("opens observed campaigns and ads separately from operator reports", async () => {
    runs = [{ id: "run-1", integration_id: "integration-1", credential_secret_id: "secret-1",
      account_id: "act_123", currency: "USD", from_date: "2026-11-01",
      through_date: "2026-11-16", fetched_at: "2026-11-16T12:00:00Z" }];
    campaigns = [{ external_campaign_id: "42", name: "Leads", status: "ACTIVE",
      effective_status: "ACTIVE", metrics_observed: true, impressions: 100, clicks: 8, spend: 12.3, actions: [] }];
    ads = [{ external_ad_id: "9", external_campaign_id: "42", external_adset_id: "7",
      name: "Image", status: "ACTIVE", effective_status: "ACTIVE", creative_id: "11",
      creative_name: "Creative", metrics_observed: true, impressions: 50, clicks: 4, spend: 6.2, actions: [] }];
    matches = [{ bundle_id: "bundle-1", reported_campaign_id: "99",
      match_state: "reported_campaign_not_observed" }];
    render(<MetaAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/reported campaign 99 · reported campaign not observed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Leads · ACTIVE · 42/ }));
    expect(screen.getByText("12.30 USD")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Image · ACTIVE · 9/ }));
    expect(screen.getByText("6.20 USD")).toBeInTheDocument();
  });

  it("hides old observations after the ad account changes", async () => {
    runs = [{ id: "run-1", integration_id: "integration-1", credential_secret_id: "secret-1",
      account_id: "act_123", currency: "USD", from_date: "2026-11-01",
      through_date: "2026-11-16", fetched_at: "2026-11-16T12:00:00Z" }];
    integration = { id: "integration-1", ad_account_id: "act_999", credential_secret_id: "secret-1" };
    render(<MetaAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/account or credential changed after the last read/)).toBeInTheDocument();
    expect(screen.queryByText(/Account act_123/)).not.toBeInTheDocument();
  });

  it("clears the previous client's account read and selection when the client changes", async () => {
    runs = [{ id: "run-1", integration_id: "integration-1", credential_secret_id: "secret-1",
      account_id: "act_123", currency: "USD", from_date: "2026-11-01",
      through_date: "2026-11-16", fetched_at: "2026-11-16T12:00:00Z" }];
    campaigns = [{ external_campaign_id: "42", name: "Leads", status: "ACTIVE",
      effective_status: "ACTIVE", metrics_observed: true, impressions: 100, clicks: 8, spend: 12.3, actions: [] }];
    const view = render(<MetaAdsReadPanel clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Leads · ACTIVE · 42/ }));
    expect(screen.getByText("12.30 USD")).toBeInTheDocument();
    runs = []; campaigns = [];
    view.rerender(<MetaAdsReadPanel clientId="client-2" />);
    expect(screen.queryByText(/Account act_123/)).not.toBeInTheDocument();
    expect(screen.queryByText("12.30 USD")).not.toBeInTheDocument();
    expect(await screen.findByText(/Inventory and metrics are unknown/)).toBeInTheDocument();
  });

  it("shows missing provider insights as unknown instead of stored zero placeholders", async () => {
    runs = [{ id: "run-1", integration_id: "integration-1", credential_secret_id: "secret-1",
      account_id: "act_123", currency: "USD", from_date: "2026-11-01",
      through_date: "2026-11-16", fetched_at: "2026-11-16T12:00:00Z" }];
    campaigns = [{ external_campaign_id: "42", name: "Leads", status: "ACTIVE",
      effective_status: "ACTIVE", metrics_observed: false,
      impressions: 0, clicks: 0, spend: 0, actions: [] }];
    render(<MetaAdsReadPanel clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Leads · ACTIVE · 42/ }));
    expect(screen.getByText(/Unknown — no provider metrics row returned/)).toBeInTheDocument();
    expect(screen.queryByText("0.00 USD")).not.toBeInTheDocument();
  });
});
