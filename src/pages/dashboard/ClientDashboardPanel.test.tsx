import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { ClientDashboardPanel, loadJobHistory } from "./ClientDashboardPanel";

const range = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            order: () => ({ range: (...args: unknown[]) => range(...args) }),
          }),
        }),
      }),
    }),
  },
}));
vi.mock("../../lib/useAgentJobs", () => ({
  useAgentJobs: () => ({ inFlight: [], recentFailures: [], loaded: true, error: null }),
}));
vi.mock("./ClientOperationalBrief", () => ({ ClientOperationalBrief: () => null }));
vi.mock("./DailyPackageSetupPanel", () => ({ DailyPackageSetupPanel: () => null }));
vi.mock("../../components/switches/ClientSwitchPanel", () => ({ ClientSwitchPanel: () => null }));
vi.mock("../../components/masterai/MasterAIChatDialog", () => ({ MasterAIChatDialog: () => null }));
vi.mock("../../components/agents/RunAgentModal", () => ({ RunAgentModal: () => null }));

it("rejects an incomplete paginated history instead of presenting partial totals", async () => {
  range.mockReset();
  range.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, index) => ({
    id: String(index), cost_usd: 1,
  })), error: null });
  range.mockResolvedValueOnce({ data: null, error: { message: "second page unavailable" } });

  await expect(loadJobHistory("client-1")).rejects.toThrow("second page unavailable");
  expect(range).toHaveBeenNthCalledWith(1, 0, 999);
  expect(range).toHaveBeenNthCalledWith(2, 1000, 1999);
});

it("shows unknown spend and a retry action when history cannot be read", async () => {
  range.mockReset();
  range.mockResolvedValue({ data: null, error: { message: "history unavailable" } });
  render(<MemoryRouter initialEntries={["/clients/client-1"]}>
    <Routes><Route path="/clients/:clientId" element={<ClientDashboardPanel />} /></Routes>
  </MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Spend and failure totals are unknown");
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("Unknown")).toBeInTheDocument();
});
