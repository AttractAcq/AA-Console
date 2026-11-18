import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ memberId: "maker-1" }) }));
vi.mock("../../../lib/options", () => ({
  useOptions: () => [], loadBriefs: vi.fn(), loadClients: vi.fn(),
  loadProductionDemands: vi.fn(),
}));
vi.mock("../../../components/forms/FormModal", () => ({
  FormModal: ({ open, onSubmit }: {
    open: boolean; onSubmit: (values: Record<string, unknown>) => Promise<void>;
  }) => open ? <>
    <button onClick={() => void onSubmit({ title: "Make asset", client_id: "client-1",
      brief_id: "brief-1", production_demand: "daily:12345678-aaaa-4bbb-8ccc-123456789abc" })}>Assign demand</button>
    <button onClick={() => void onSubmit({ title: "Older campaign asset", client_id: "client-1",
      brief_id: "brief-1", production_demand: "manual", manual_demand_kind: "campaign",
      manual_demand_id: "87654321-bbbb-4ccc-8ddd-123456789abc" })}>Assign exact older</button>
    <button onClick={() => void onSubmit({ title: "General work", client_id: "client-1",
      brief_id: "brief-1" })}>Assign general</button>
  </> : null,
}));

import { CurrentJobsSection } from "./CurrentJobsSection";

beforeEach(() => {
  from.mockReset(); rpc.mockReset();
  from.mockImplementation(() => {
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query,
      insert: vi.fn().mockResolvedValue({ error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  });
  rpc.mockResolvedValue({ error: null });
});

it("binds a selected human job to the exact production demand", async () => {
  render(<CurrentJobsSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Assign Job" }));
  await userEvent.click(screen.getByRole("button", { name: "Assign demand" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_demand_assignment_v7", {
    p_member_id: "maker-1", p_client_id: "client-1", p_brief_id: "brief-1",
    p_demand_kind: "daily", p_demand_id: "12345678-aaaa-4bbb-8ccc-123456789abc", p_title: "Make asset",
    p_due_date: undefined, p_compensation: undefined,
  }));
  expect(from.mock.results.some((call) => call.value.insert?.mock.calls.length)).toBe(false);
});

it("accepts an exact campaign request ID outside the loaded choices", async () => {
  render(<CurrentJobsSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Assign Job" }));
  await userEvent.click(screen.getByRole("button", { name: "Assign exact older" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_demand_assignment_v7",
    expect.objectContaining({ p_demand_kind: "campaign",
      p_demand_id: "87654321-bbbb-4ccc-8ddd-123456789abc" })));
});

it("keeps ordinary assignments available without inventing a demand link", async () => {
  render(<CurrentJobsSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Assign Job" }));
  await userEvent.click(screen.getByRole("button", { name: "Assign general" }));
  await waitFor(() => expect(from.mock.results.some((call) =>
    call.value.insert?.mock.calls.length === 1)).toBe(true));
  expect(rpc).not.toHaveBeenCalled();
});

it("reads the recorded request binding back on the assignment table", async () => {
  from.mockImplementation((table: string) => {
    const data = table === "job_assignments"
      ? [{ id: "job-1", title: "Produce image", due_date: null,
        compensation: null, completed_at: null }]
      : [{ assignment_id: "job-1", demand_kind: "campaign",
        demand_id: "12345678-aaaa-bbbb-cccc-123456789abc" }];
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve),
    };
    return query;
  });
  render(<CurrentJobsSection />);
  expect(await screen.findByText("campaign · 12345678")).toBeInTheDocument();
});
