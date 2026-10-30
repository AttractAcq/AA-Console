import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, assertOrganicScheduleRoute } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  assertOrganicScheduleRoute: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("../../lib/scheduleRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/scheduleRoute")>()),
  assertOrganicScheduleRoute,
}));
vi.mock("../../lib/options", () => ({
  useOptions: () => [{ value: "asset-1", label: "AA-014 · Chair shot" }],
  loadApprovedAssets: vi.fn(),
  CHANNEL_OPTIONS: [{ value: "organic", label: "Organic" }, { value: "paid", label: "Paid" }],
}));

import { CalendarPanel } from "./CalendarPanel";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
  assertOrganicScheduleRoute.mockResolvedValue(undefined);
  from.mockImplementation(() => {
    const chain = {
      select: () => chain,
      order: async () => ({ data: [], error: null }),
    };
    return chain;
  });
});

async function openForm() {
  render(<CalendarPanel />);
  await userEvent.click(await screen.findByRole("button", { name: "Add Event" }));
  const dialog = within(screen.getByRole("dialog"));
  await userEvent.type(dialog.getByLabelText(/^Date/), "2026-10-09");
  await userEvent.selectOptions(dialog.getByLabelText(/^Asset/), "asset-1");
  return dialog;
}

describe("operations calendar scheduling", () => {
  it("checks explicit organic lineage before calling schedule_asset", async () => {
    const dialog = await openForm();
    await userEvent.selectOptions(dialog.getByLabelText(/^Channel/), "organic");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("schedule_asset", {
      p_asset_id: "asset-1", p_date: "2026-10-09", p_channel: "organic",
    }));
    expect(assertOrganicScheduleRoute).toHaveBeenCalledWith("asset-1", "organic");
  });

  it("names the paid route blocker and never calls schedule_asset", async () => {
    assertOrganicScheduleRoute.mockRejectedValueOnce(new Error("Paid scheduling is unavailable until its own distribution route is released."));
    const dialog = await openForm();
    await userEvent.selectOptions(dialog.getByLabelText(/^Channel/), "paid");
    expect(dialog.getByText(/Paid scheduling is unavailable/i)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/Paid scheduling is unavailable/i);
    expect(assertOrganicScheduleRoute).toHaveBeenCalledWith("asset-1", "paid");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("blocks a legacy asset whose campaign lineage cannot be verified", async () => {
    assertOrganicScheduleRoute.mockRejectedValueOnce(new Error("Scheduling blocked: no verified organic campaign route"));
    const dialog = await openForm();
    await userEvent.selectOptions(dialog.getByLabelText(/^Channel/), "organic");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(/no verified organic campaign route/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
