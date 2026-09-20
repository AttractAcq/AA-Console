import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from, useParams, fetchClientAssets, signPaths, fetchTextBodies } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  useParams: vi.fn(),
  fetchClientAssets: vi.fn(),
  signPaths: vi.fn(),
  fetchTextBodies: vi.fn(),
}));
vi.mock("../lib/supabase", () => ({ supabase: { rpc, from } }));
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
  const reviews = {
    select: () => reviews,
    eq: () => reviews,
    order: () => reviews,
    limit: () => Promise.resolve({ data: [{ reason: "Wrong logo lockup." }], error: null }),
  };
  from.mockReturnValue(reviews);
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


describe("regenerating an asset", () => {
  const withStatus = (status: string, over: Record<string, unknown> = {}) =>
    asset({ review_status: status, brief_id: "b1", ...over });

  // Not only rejections. An approved asset that is nearly right is the
  // common case, and there was no way to act on it at all.
  it("offers a rebuild on an approved asset as well as a rejected one", async () => {
    for (const status of ["approved", "rejected"]) {
      fetchClientAssets.mockResolvedValue([withStatus(status)]);
      const view = render(<MediaLibrary mediaType="image" />);
      expect(await screen.findByRole("button", { name: /Regenerate/i })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("offers approve and reject instead while it is still pending", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("pending")]);
    render(<MediaLibrary mediaType="image" />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Regenerate/i })).not.toBeInTheDocument();
  });

  // The RPC refuses an asset with no brief, so the button would be a
  // guaranteed failure.
  it("offers nothing when there is no brief to rebuild from", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("approved", { brief_id: null })]);
    render(<MediaLibrary mediaType="image" />);
    await screen.findByText("Chair shot");
    expect(screen.queryByRole("button", { name: /Regenerate/i })).not.toBeInTheDocument();
  });

  it("will not rebuild with nothing said", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("approved")]);
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: /Regenerate/i }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends what the operator typed", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("approved")]);
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: /Regenerate/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.type(dialog.getByLabelText(/What is wrong/i), "Headline unreadable.");
    await userEvent.click(dialog.getByRole("button", { name: "Regenerate" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("regenerate_asset", {
        p_asset_id: "a1",
        p_feedback: "Headline unreadable.",
      }),
    );
  });

  // The rejection reason already answers this question; asking again is
  // asking twice.
  it("starts a rejected asset from its recorded reason", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("rejected")]);
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: /Regenerate/i }));
    expect(await screen.findByDisplayValue("Wrong logo lockup.")).toBeInTheDocument();
  });

  it("starts an approved asset from an empty box", async () => {
    fetchClientAssets.mockResolvedValue([withStatus("approved")]);
    render(<MediaLibrary mediaType="image" />);
    await userEvent.click(await screen.findByRole("button", { name: /Regenerate/i }));
    const dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText(/What is wrong/i) as HTMLTextAreaElement).value).toBe("");
  });
});
