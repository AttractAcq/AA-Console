import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// The point of the archive is that the working lists stop carrying finished
// work. These assert the filter is actually sent — a panel that forgets it
// looks identical until the list is 300 rows long again.
const calls: { table: string; filters: string[] }[] = [];

vi.mock("../../lib/supabase", () => {
  const makeChain = (table: string) => {
    const record = { table, filters: [] as string[] };
    calls.push(record);
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "in", "not", "order", "limit"]) {
      chain[method] = (...args: unknown[]) => {
        if (method !== "select") record.filters.push(`${method}:${String(args[0])}`);
        return chain;
      };
    }
    chain.is = (column: string, value: unknown) => {
      record.filters.push(`is:${column}=${String(value)}`);
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return chain;
  };
  // RecordWorkspace subscribes to job changes; these panels are being rendered
  // only to see which filters they send, so realtime is a stub.
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      from: (table: string) => makeChain(table),
      rpc: vi.fn(),
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("../../lib/options", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useOptions: () => ({ options: [], loading: false }),
  loadContentPillars: vi.fn(),
  loadProofAssets: vi.fn(),
}));

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));

const { GenerationPanel } = await import("../ideation/GenerationPanel");
const { BriefsPanel } = await import("../ideation/BriefsPanel");
const { PageBuilderPanel } = await import("../conversion/PageBuilderPanel");
const { CampaignExecutionPanel } = await import("../campaigns/CampaignExecutionPanel");
const { SalesOverviewPanel } = await import("../sales/SalesOverviewPanel");
const { MarketOpportunitiesPanel } = await import("../opportunities/MarketOpportunitiesPanel");
const { RecordWorkspace } = await import("../../components/records/RecordWorkspace");

const show = (ui: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={["/clients/c1"]}>
      <Routes>
        <Route path="/clients/:clientId" element={ui} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  calls.length = 0;
});

describe("the active lists exclude archived work", () => {
  it("Ideation asks only for ideas that are not archived", async () => {
    show(<GenerationPanel watchJobs={false} />);
    await waitFor(() => {
      const ideas = calls.find((c) => c.table === "client_ideas");
      expect(ideas?.filters).toContain("is:archived_at=null");
    });
  });

  it("Briefs asks only for briefs that are not archived", async () => {
    show(<BriefsPanel />);
    await waitFor(() => {
      const briefs = calls.find((c) => c.table === "client_briefs");
      expect(briefs?.filters).toContain("is:archived_at=null");
    });
  });

  it("Page Builder asks only for pages that are not archived", async () => {
    show(<PageBuilderPanel pageType="landing" />);
    await waitFor(() => {
      const pages = calls.find((c) => c.table === "client_pages");
      expect(pages?.filters).toContain("is:archived_at=null");
    });
  });

  it("Campaigns asks only for campaigns that are not archived", async () => {
    show(<CampaignExecutionPanel />);
    await waitFor(() => {
      const campaigns = calls.find((c) => c.table === "client_campaigns");
      expect(campaigns?.filters).toContain("is:archived_at=null");
    });
  });

  it("Sales Agents asks only for agents that are not archived", async () => {
    show(<SalesOverviewPanel />);
    await waitFor(() => {
      const agents = calls.find((c) => c.table === "client_sales_agents");
      expect(agents?.filters).toContain("is:archived_at=null");
    });
  });

  it("Market Opportunities asks only for opportunities that are not archived", async () => {
    // Migration 312 made these archivable.
    show(<MarketOpportunitiesPanel view="discover" />);
    await waitFor(() => {
      const opps = calls.find((c) => c.table === "market_opportunities");
      expect(opps?.filters).toContain("is:archived_at=null");
    });
  });

  it("the model workspaces ask only for records that are not archived", async () => {
    // One table holds every intelligence and strategy domain -- 359 records in
    // production -- so a missing filter here is exactly the "300 rows long
    // again" failure this file was written for, and it would hit every domain
    // at once rather than one page.
    show(<RecordWorkspace domain="money_model" />);
    await waitFor(() => {
      const records = calls.find((c) => c.table === "client_agent_records");
      expect(records?.filters).toContain("is:archived_at=null");
    });
  });
});
