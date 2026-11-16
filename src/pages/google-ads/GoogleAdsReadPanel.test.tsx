import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, enqueueAgentJob } = vi.hoisted(() => ({ from:vi.fn(), enqueueAgentJob:vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase:{from}, enqueueAgentJob }));

import { GoogleAdsReadPanel } from "./GoogleAdsReadPanel";

let runs: unknown[];
let campaigns: unknown[];
let matches: unknown[];
let integration: unknown;
beforeEach(() => {
  vi.clearAllMocks();
  runs=[]; campaigns=[]; matches=[];
  integration={id:"integration-1",google_ads_customer_id:"1234567890",
    credential_secret_id:"secret-1"};
  enqueueAgentJob.mockResolvedValue("job-1");
  from.mockImplementation((table:string) => {
    const data = table==="google_ads_read_runs_v7" ? runs
      : table==="google_ads_campaign_reads_v7" ? campaigns : matches;
    const chain: Record<string,unknown> = {};
    Object.assign(chain, { select:()=>chain,eq:()=>chain,order:()=>chain,
      limit:async()=>({data,error:null}),
      maybeSingle:async()=>({data:integration,error:null}) });
    return chain;
  });
});

describe("Google Ads read-only account view", () => {
  it("keeps absent provider data unknown and only queues a read job", async () => {
    render(<GoogleAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/Inventory and metrics are unknown/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button",{name:"Read Google Ads account"}));
    expect(enqueueAgentJob).toHaveBeenCalledWith({agentKey:"google_ads_read",clientId:"client-1"});
    expect(await screen.findByText(/Read-only Google Ads job queued/)).toBeInTheDocument();
  });

  it("shows provider-observed campaign metrics and separates an unmatched reported ID", async () => {
    runs=[{id:"run-1",client_id:"client-1",integration_id:"integration-1",
      credential_secret_id:"secret-1",
      customer_id:"1234567890",currency:"USD",
      from_date:"2026-11-01",through_date:"2026-11-16",fetched_at:"2026-11-16T12:00:00Z",
      provider_request_id:"request-1"}];
    campaigns=[{run_id:"run-1",client_id:"client-1",external_campaign_id:"42",
      name:"Lead search",status:"ENABLED",channel:"SEARCH",impressions:100,clicks:8,
      cost_micros:1230000,conversions:1.25}];
    matches=[{bundle_id:"bundle-1",reported_campaign_id:"99",
      match_state:"reported_id_not_observed"}];
    render(<GoogleAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/reported 99 · reported id not observed/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button",{name:/Lead search · ENABLED · 42/}));
    expect(screen.getByText("1.23 USD")).toBeInTheDocument();
    expect(screen.getByText("1.25")).toBeInTheDocument();
  });

  it("hides historical metrics after the configured customer changes", async () => {
    runs=[{id:"run-1",client_id:"client-1",integration_id:"integration-1",
      credential_secret_id:"secret-1",
      customer_id:"1234567890",currency:"USD",from_date:"2026-11-01",
      through_date:"2026-11-16",fetched_at:"2026-11-16T12:00:00Z",
      provider_request_id:"request-1"}];
    integration={id:"integration-1",google_ads_customer_id:"9999999999",
      credential_secret_id:"secret-1"};
    render(<GoogleAdsReadPanel clientId="client-1" />);
    expect(await screen.findByText(/account or credential changed after the last read/)).toBeInTheDocument();
    expect(screen.queryByText(/Customer 1234567890/)).not.toBeInTheDocument();
  });
});
