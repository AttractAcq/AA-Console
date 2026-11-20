import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";

const { from, inFilter } = vi.hoisted(() => ({ from: vi.fn(), inFilter: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../components/ProductionAttemptComparison", () => ({
  ProductionAttemptComparison: () => null,
}));
import { CampaignProductionOverview } from "./CampaignProductionOverview";

function rows(data: unknown[]) {
  const query = {
    select: () => query, eq: () => query,
    in: (field: string, ids: string[]) => { inFilter(field, ids); return query; },
    not: () => query, is: () => query, order: () => query, limit: () => query,
    then: (resolve: (result: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return query;
}

it("shows campaign requests and blockers from the shared production records", async () => {
  from.mockImplementation((table: string) => table === "client_campaigns"
    ? rows([{ id: "campaign-1", name: "Focused paid and organic" }])
    : table === "campaign_route_packages_v6"
      ? rows([{ id: "route-new", campaign_id: "campaign-1", route: "paid", version: 2 },
        { id: "route-old", campaign_id: "campaign-1", route: "paid", version: 1 }])
    : table === "production_demand_counts_v8"
      ? rows([{ demand_id: "work-1", campaign_id: "campaign-1", route_package_id: "route-new", piece_key: "piece1",
        destination: "instagram", media_type: "image", content_format: "single",
        attempts: 2, produced: 1, rejected: 1, revised: 1,
        workflow_accepted: 1, human_approved: 0 }])
      : rows([{ id: "work-1", effective_state: "held",
        effective_blocker: "The selected proof right was revoked." }]));
  render(<MemoryRouter initialEntries={["/clients/client-1"]}><Routes>
    <Route path="/clients/:clientId" element={<CampaignProductionOverview />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Focused paid and organic" }))
    .toHaveAttribute("href", "/clients/client-1/delivery/campaign-factory/campaign-1");
  expect(screen.getByText(/1 requested · 1 produced · 1 failed or rejected attempts · 1 revised · 1 passed workflow QA · 0 human approved/))
    .toBeInTheDocument();
  expect(screen.getByText("The selected proof right was revoked.")).toBeInTheDocument();
  expect(screen.getByText(/piece1 · paid v2/)).toBeInTheDocument();
  expect(inFilter).toHaveBeenCalledWith("route_package_id", ["route-new"]);
  expect(screen.getByText(/Request ID:/)).toHaveTextContent("work-1");
  const readsBeforeRefresh = from.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh campaign work" }));
  await waitFor(() => expect(from.mock.calls.length).toBeGreaterThan(readsBeforeRefresh));
});
