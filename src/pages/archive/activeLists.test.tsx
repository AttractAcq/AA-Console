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
  return { supabase: { from: (table: string) => makeChain(table), rpc: vi.fn() } };
});

vi.mock("../../lib/options", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useOptions: () => ({ options: [], loading: false }),
  loadContentPillars: vi.fn(),
  loadProofAssets: vi.fn(),
}));

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));

const { GenerationPanel } = await import("../ideation/GenerationPanel");
const { BriefsPanel } = await import("../ideation/BriefsPanel");

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
});
