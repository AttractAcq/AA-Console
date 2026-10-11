import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, signPaths, useParams, setSearchParams, navigate } = vi.hoisted(() => ({
  from: vi.fn(), signPaths: vi.fn(), useParams: vi.fn(), setSearchParams: vi.fn(), navigate: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../lib/media", () => ({ signPaths }));
vi.mock("react-router-dom", () => ({
  useParams,
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), setSearchParams],
}));
vi.mock("../../components/MediaLibrary", () => ({
  MediaLibrary: ({ mediaType }: { mediaType: string }) => <div>library:{mediaType}</div>,
}));

import { VideoLibraryPanel } from "./VideoLibraryPanel";

function show(rows: Array<Record<string, unknown>>) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  from.mockReturnValue(query);
  return render(<VideoLibraryPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  signPaths.mockResolvedValue(new Map([["client-1/reel/cut.mp4", "https://example.test/cut.mp4"]]));
});

describe("reels in the video library", () => {
  it("routes avatar footage to Edit / Repurpose instead of calling it an unfinished AI cut", async () => {
    show([{ id: "r1", title: "Raw footage", render_path: null, edit_stage: "needs_edit",
      review_status: "pending", brief_id: "b1" }]);
    expect(await screen.findByText(/1 source video is in Edit \/ Repurpose/)).toBeInTheDocument();
    expect(screen.queryByText(/in Create \/ Edit/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open editing work" }));
    expect(navigate).toHaveBeenCalledWith("/clients/client-1/delivery/edit-repurpose?tab=overview");
  });
  it("links an unfinished reel to its production view", async () => {
    show([{ id: "r1", title: "Idea", render_path: null, review_status: "pending", brief_id: "b1" }]);
    expect(await screen.findByText(/1 reel is in Create \/ Edit/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reel shots" }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: "reel-shots" });
    expect(screen.getByText("library:video")).toBeInTheDocument();
  });

  it("plays the rendered cut and links back to the brief", async () => {
    show([{ id: "r1", title: "Finished reel", render_path: "client-1/reel/cut.mp4", review_status: "pending", brief_id: "b1" }]);
    const video = await screen.findByRole("region", { name: "Finished reels" });
    await waitFor(() => expect(video.querySelector("video")?.getAttribute("src")).toBe("https://example.test/cut.mp4"));
    expect(screen.queryByText(/in Create \/ Edit/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "View production and approval" }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: "reel-shots", brief: "b1" });
  });
});
