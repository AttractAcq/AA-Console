import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, fetchClientAssets, signPaths, fetchTextBodies } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  fetchClientAssets: vi.fn(),
  signPaths: vi.fn(),
  fetchTextBodies: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../lib/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/media")>()),
  fetchClientAssets,
  signPaths,
  fetchTextBodies,
}));

import { AssetsPanel } from "./AssetsPanel";

const asset = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  title: "Chair shot",
  ref_number: "AA-014",
  media_type: "image",
  storage_path: "p/1.png",
  review_status: "approved",
  created_at: "2026-09-10T00:00:00Z",
  ...over,
});

function posts(rows: unknown[]) {
  const chain = { select: () => chain, eq: () => Promise.resolve({ data: rows, error: null }) };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  signPaths.mockResolvedValue(new Map());
  fetchTextBodies.mockResolvedValue(new Map());
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation(() => posts([]));
  fetchClientAssets.mockResolvedValue([asset()]);
});

describe("what the tab is for", () => {
  it("asks only for approved assets", async () => {
    render(<AssetsPanel />);
    await screen.findByText("Chair shot");
    expect(fetchClientAssets).toHaveBeenCalledWith("client-1", { reviewStatus: "approved" });
  });

  it("counts what still has no date", async () => {
    render(<AssetsPanel />);
    expect(await screen.findByText(/1 still has no date/i)).toBeInTheDocument();
  });

  it("says so when everything is scheduled", async () => {
    from.mockImplementation(() =>
      posts([{ asset_id: "a1", scheduled_for: "2026-10-02", channel: "organic", platform: "instagram", published_at: null }]),
    );
    render(<AssetsPanel />);
    expect(await screen.findByText(/All of it is scheduled/i)).toBeInTheDocument();
  });
});

describe("scheduling from the asset", () => {
  it("sends the date, channel and platform", async () => {
    render(<AssetsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Schedule/i }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByLabelText("Date"), "2026-10-09");
    await userEvent.selectOptions(dialog.getByLabelText("Channel"), "paid");
    await userEvent.selectOptions(dialog.getByLabelText("Platform"), "tiktok");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("schedule_asset", {
        p_asset_id: "a1",
        p_date: "2026-10-09",
        p_channel: "paid",
        p_platform: "tiktok",
      }),
    );
  });

  // Undecided is a real answer; "" would fail the enum.
  it("omits the platform when none is chosen", async () => {
    render(<AssetsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Schedule/i }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByLabelText("Date"), "2026-10-09");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("schedule_asset", {
        p_asset_id: "a1",
        p_date: "2026-10-09",
        p_channel: "organic",
      }),
    );
  });

  it("surfaces a refusal from the gate rather than looking successful", async () => {
    rpc.mockResolvedValue({ error: { message: "Asset must be approved before it can be scheduled" } });
    render(<AssetsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Schedule/i }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByLabelText("Date"), "2026-10-09");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must be approved/i);
  });
});

// An asset that vanishes twice is one nobody can confirm they dealt with.
describe("an asset that is already scheduled", () => {
  beforeEach(() =>
    from.mockImplementation(() =>
      posts([{ asset_id: "a1", scheduled_for: "2026-10-02", channel: "organic", platform: "instagram", published_at: null }]),
    ),
  );

  it("stays on the list, showing where and when it goes", async () => {
    render(<AssetsPanel />);
    expect(await screen.findByText("Chair shot")).toBeInTheDocument();
    expect(screen.getByText(/organic · Instagram/i)).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
  });

  it("offers no second schedule for it", async () => {
    render(<AssetsPanel />);
    await screen.findByText("Chair shot");
    expect(screen.queryByRole("button", { name: /^Schedule$/ })).not.toBeInTheDocument();
  });
});
