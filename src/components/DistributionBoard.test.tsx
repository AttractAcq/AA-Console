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

/** A row of the distribution_due view, which is a different shape to a post. */
const dueRow = (over: Record<string, unknown> = {}) => ({
  schedule_id: "p1",
  asset_id: "asset-1",
  ref_number: "AA-014",
  scheduled_for: "2026-09-09",
  channel: "organic",
  platform: "instagram",
  media_type: "image",
  asset_title: "Chair shot",
  state: "overdue",
  days_late: 13,
  human_approved: true,
  ...over,
});

/**
 * Answer each table with its own rows. One chain for both made the board's
 * tests pass by accident: the due view returned posts, which carry no state,
 * so the banner stayed silent whatever the data said.
 */
function byTable(posts: unknown[], due: unknown[] = []) {
  return (table: string) => postsReturn(table === "distribution_due" ? due : posts);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  fetchClientAssets.mockResolvedValue([
    { id: "asset-1", ref_number: "AA-014", title: "Chair shot" },
  ]);
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation(byTable([post()]));
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

  // Undecided is a real answer. "" would fail the enum, so the key is left
  // out and the function's own default applies.
  it("omits the platform entirely when none is picked", async () => {
    const dialog = await openScheduler();
    await userEvent.selectOptions(dialog.getByLabelText(/^Asset/), "asset-1");
    await userEvent.type(dialog.getByLabelText(/^Date/), "2026-10-09");
    await userEvent.click(dialog.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("schedule_asset", {
      p_asset_id: "asset-1",
      p_date: "2026-10-09",
      p_channel: "organic",
    });
  });
});

describe("what is late", () => {
  // The board rendered published_at ? "Published" : "Scheduled", so a post
  // 13 days past its date still read as Scheduled and nothing said otherwise.
  it("says how overdue a post is instead of calling it scheduled", async () => {
    from.mockImplementation(byTable([post()], [dueRow()]));
    render(<DistributionBoard channel="organic" />);
    expect(await screen.findByText("Overdue by 13 days")).toBeInTheDocument();
    expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
  });

  it("warns at the top of the board, with the age of the worst one", async () => {
    from.mockImplementation(byTable([post()], [dueRow()]));
    render(<DistributionBoard channel="organic" />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "1 post overdue, the oldest by 13 days.",
    );
  });

  // An orphan can never publish however long anyone waits, so it is not late.
  it("names a post whose asset was deleted as unpublishable", async () => {
    from.mockImplementation(byTable([post()], [dueRow({ state: "orphaned", asset_id: null })]));
    render(<DistributionBoard channel="organic" />);
    expect(await screen.findByText("No asset — cannot publish")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("can never publish");
  });

  it("stays quiet when nothing is late", async () => {
    from.mockImplementation(byTable([post()], [dueRow({ state: "upcoming", days_late: 0 })]));
    render(<DistributionBoard channel="organic" />);
    expect(await screen.findByText("Scheduled")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
