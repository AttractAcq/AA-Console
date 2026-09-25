import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ActiveCampaignsView } from "../client/ClientViews";
import { CampaignsPanel } from "../operations/CampaignsPanel";
const { from, rpc, eq } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), eq: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
const clientId = "e4b4b001-81f6-4997-8429-ff21f4ee1fbe";
const campaign = (id: string, status = "planning", owner = clientId) => ({
  id, client_id: owner, name: `Campaign ${id}`, status, objective: "Grow", channels: ["email"],
  starts_on: "2026-09-15", ends_on: null, needs_landing_page: true, needs_sales_agent: false,
});
function mockRows(rows: unknown[], error: unknown = null) {
  from.mockImplementation((table: string) => {
    const chain = { select: () => chain, order: () => chain, eq: (...args: unknown[]) => { eq(...args); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === "clients"
        ? { data: [{ id: clientId, name: "Attract Acquisition" }, { id: "other", name: "Other client" }], error: null }
        : { data: rows, error }).then(resolve) };
    return chain;
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: [{ requirement: "Content", met: true, detail: "2 of 2 ready" }], error: null });
});
it("shows no live campaigns and all 15 planning without implying none exist", async () => {
  mockRows(Array.from({ length: 15 }, (_, i) => campaign(String(i))));
  render(<ActiveCampaignsView clientId={clientId} />);
  expect(screen.getByText("Loading campaigns…")).toBeInTheDocument();
  expect(await screen.findByText("No live campaigns")).toBeInTheDocument();
  expect(screen.getByText("15 campaigns are currently in planning.")).toBeInTheDocument();
  expect(from).toHaveBeenCalledWith("client_campaigns");
  expect(eq).toHaveBeenCalledWith("client_id", clientId);
});
it("shows live campaigns in Active", async () => {
  mockRows([campaign("live", "live"), campaign("planned")]);
  render(<ActiveCampaignsView clientId={clientId} />);
  expect(await screen.findByText("Campaign live")).toBeInTheDocument();
  expect(screen.queryByText("Campaign planned")).not.toBeInTheDocument();
});
it("lists canonical campaigns across clients and filters readiness, status and client", async () => {
  mockRows([campaign("planned"), campaign("live", "live", "other")]);
  render(<MemoryRouter><CampaignsPanel /></MemoryRouter>);
  expect(await screen.findByText("Campaign live")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Campaign planned" })).toHaveAttribute("href", `/clients/${clientId}/delivery/campaign-execution/planned`);
  expect(from).not.toHaveBeenCalledWith("campaigns");
  expect(eq).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Ready to Launch" }));
  expect(screen.queryByText("Campaign live")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Live" }));
  expect(screen.getByText("Campaign live")).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole("combobox"), clientId);
  expect(screen.getByText("No campaigns match these filters")).toBeInTheDocument();
});
it.each(["active", "ops"])("surfaces query failure in %s", async surface => {
  mockRows([], { message: "permission denied" });
  render(<MemoryRouter>{surface === "active" ? <ActiveCampaignsView clientId={clientId} /> : <CampaignsPanel />}</MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load campaigns: permission denied");
  expect(screen.queryByText("No live campaigns")).not.toBeInTheDocument();
  expect(screen.queryByText("No campaigns yet")).not.toBeInTheDocument();
});
it("keeps campaigns visible when readiness fails and never treats them as ready", async () => {
  mockRows([campaign("planned")]);
  rpc.mockResolvedValue({ data: null, error: { message: "RPC denied" } });
  render(<MemoryRouter><CampaignsPanel /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load readiness");
  expect(screen.getByText("Campaign planned")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Ready to Launch" }));
  expect(screen.queryByText("Campaign planned")).not.toBeInTheDocument();
});
