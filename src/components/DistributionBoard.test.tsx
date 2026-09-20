import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, fetchClientAssets } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  fetchClientAssets: vi.fn(),
}));
vi.mock("../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../lib/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/media")>()),
  fetchClientAssets,
}));

import { DistributionBoard } from "./DistributionBoard";

const post = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  scheduled_for: "2026-10-02",
  ref_number: "AA-014",
  media_type: "image",
  platform: "instagram",
  published_at: null,
  ...over,
});

function postsReturn(rows: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  fetchClientAssets.mockResolvedValue([
    { id: "asset-1", ref_number: "AA-014", title: "Chair shot" },
  ]);
  rpc.mockResolvedValue({ error: null });
  from.mockReturnValue(postsReturn([post()]));
});

async function openScheduler() {
  render(<DistributionBoard channel="organic" />);
  await userEvent.click(await screen.findByRole("button", { name: /Schedule Organic/i }));
  await screen.findByLabelText(/^Platform/);
  // Labels carry a "required" marker, and the dialog title contains "asset"
  // too, so queries are scoped and anchored rather than loose.
  return within(screen.getByRole("dialog"));
}

describe("the board", () => {
  it("shows which platform a scheduled post goes to", async () => {
    render(<DistributionBoard channel="organic" />);
    expect(await screen.findByText("Instagram")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Platform" })).toBeInTheDocument();
  });

  it("shows a dash for a post scheduled before platforms were recorded", async () => {
    from.mockReturnValue(postsReturn([post({ platform: null })]));
    render(<DistributionBoard channel="organic" />);
    const row = await screen.findByText("AA-014");
    expect(within(row.closest("tr")!).getByText("—")).toBeInTheDocument();
  });
});

describe("scheduling", () => {
  it("sends the platform the operator picked", async () => {
    const dialog = await openScheduler();
    await userEvent.selectOptions(dialog.getByLabelText(/^Asset/), "asset-1");
    await userEvent.type(dialog.getByLabelText(/^Date/), "2026-10-09");
    await userEvent.selectOptions(dialog.getByLabelText(/^Platform/), "tiktok");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("schedule_asset", {
        p_asset_id: "asset-1",
        p_date: "2026-10-09",
        p_channel: "organic",
        p_platform: "tiktok",
      }),
    );
  });

  // Undecided is a real answer. "" would fail the enum; null records that
  // nobody has chosen yet.
  it("sends null rather than an empty string when no platform is picked", async () => {
    const dialog = await openScheduler();
    await userEvent.selectOptions(dialog.getByLabelText(/^Asset/), "asset-1");
    await userEvent.type(dialog.getByLabelText(/^Date/), "2026-10-09");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "schedule_asset",
        expect.objectContaining({ p_platform: null }),
      ),
    );
  });
});
