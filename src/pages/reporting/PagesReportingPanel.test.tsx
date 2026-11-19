import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, useParams } = vi.hoisted(() => ({ rpc: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));

import { PagesReportingPanel } from "./PagesReportingPanel";

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("page outcomes", () => {
  it("shows recorded first-source outcomes and calls out missing traffic coverage", async () => {
    rpc.mockResolvedValue({ data: [{ page_id: "page-1", page_title: "Winter offer",
      archived_at: "2026-11-01T00:00:00Z", recorded_leads: 3,
      consented_leads: 2, recorded_sales: 1, recorded_cash: 1200,
      latest_lead_at: "2026-11-18T10:00:00Z" }], error: null });
    render(<PagesReportingPanel pageType="offer" />);
    expect(await screen.findByText(/Winter offer · archived/)).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByText(/Page visits, conversion rate/)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("page_recorded_outcomes_v8", {
      p_client_id: "client-1", p_page_type: "offer", p_days: 30,
    });
  });

  it("changes the reporting window without retaining an earlier response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    rpc.mockImplementation((_name: string, args: { p_days: number }) => args.p_days === 30
      ? gate.then(() => ({ data: [{ page_id: "old", page_title: "Old page",
        recorded_leads: 1, consented_leads: 1, recorded_sales: 0,
        recorded_cash: 0, latest_lead_at: null, archived_at: null }], error: null }))
      : Promise.resolve({ data: [], error: null }));
    render(<PagesReportingPanel pageType="landing" />);
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(await screen.findByText("No landing pages are recorded for this client.")).toBeInTheDocument();
    await act(async () => { release(); });
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });

  it("shows an unavailable read as unknown", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "denied" } });
    render(<PagesReportingPanel pageType="landing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No zero totals can be inferred");
  });
});
