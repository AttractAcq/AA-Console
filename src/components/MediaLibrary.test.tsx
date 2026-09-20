import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, useParams, fetchClientAssets, signPaths, fetchTextBodies } = vi.hoisted(() => ({
  rpc: vi.fn(),
  useParams: vi.fn(),
  fetchClientAssets: vi.fn(),
  signPaths: vi.fn(),
  fetchTextBodies: vi.fn(),
}));
vi.mock("../lib/supabase", () => ({ supabase: { rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../lib/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/media")>()),
  fetchClientAssets,
  signPaths,
  fetchTextBodies,
}));

import { MediaLibrary } from "./MediaLibrary";

const asset = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  title: "Chair shot",
  ref_number: "AA-014",
  media_type: "image",
  storage_path: "p/1.png",
  review_status: "pending",
  created_at: "2026-09-10T00:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  signPaths.mockResolvedValue(new Map());
  fetchTextBodies.mockResolvedValue(new Map());
  rpc.mockResolvedValue({ error: null });
  fetchClientAssets.mockResolvedValue([asset()]);
});

describe("approving from the library", () => {
  it("offers the decision on a pending asset", async () => {
    render(<MediaLibrary mediaType="image" />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("offers nothing on an asset already decided", async () => {
    fetchClientAssets.mockResolvedValue([asset({ review_status: "approved" })]);
    render(<MediaLibrary mediaType="image" />);
    await screen.findByText("Chair shot");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("approves through the same RPC every other screen uses", async () => {
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("review_media_asset", {
        p_asset_id: "a1",
        p_decision: "approved",
        p_reason: undefined,
      }),
    );
  });

  // A rejection with no reason sends the maker back with nothing to act on.
  it("will not reject without a reason", async () => {
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the reason with the rejection", async () => {
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByLabelText(/Why it is rejected/i), "Wrong logo lockup.");
    await userEvent.click(dialog.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("review_media_asset", {
        p_asset_id: "a1",
        p_decision: "rejected",
        p_reason: "Wrong logo lockup.",
      }),
    );
  });

  it("shows a refusal rather than appearing to succeed", async () => {
    rpc.mockResolvedValue({ error: { message: "Not permitted for this client" } });
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Not permitted/i);
  });
});
