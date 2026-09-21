import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FrameStrip } from "./FrameStrip";

const rpc = vi.fn();
const fetchFrames = vi.fn();
const signPaths = vi.fn();

vi.mock("../lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("../lib/frames", () => ({ fetchFrames: (id: string) => fetchFrames(id) }));
vi.mock("../lib/media", () => ({ signPaths: (...a: unknown[]) => signPaths(...a) }));

const frames = [
  { id: "f1", position: 1, storage_path: "c/r/01.png", caption: "Stop overpaying" },
  { id: "f2", position: 2, storage_path: "c/r/02.jpg", caption: "The objection" },
  { id: "f3", position: 3, storage_path: "c/r/03.png", caption: null },
];

const show = (onQueued = vi.fn(), onError = vi.fn()) => {
  render(<FrameStrip assetId="a1" onQueued={onQueued} onError={onError} />);
  return { onQueued, onError };
};

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null });
  fetchFrames.mockReset().mockResolvedValue(frames);
  signPaths.mockReset().mockResolvedValue(new Map(frames.map((f) => [f.storage_path, `url:${f.position}`])));
});

describe("FrameStrip", () => {
  it("shows every frame, not just the cover", async () => {
    show();
    await waitFor(() => expect(screen.getByText("3 frames, in order")).toBeTruthy());
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getByAltText("Stop overpaying")).toBeTruthy();
    expect(screen.getByAltText("Frame 3")).toBeTruthy();
  });

  // A strip that cannot load is decoration failing, not the asset being
  // broken — the same rule countFrames follows after it blanked the library.
  it("renders nothing rather than throwing when the frames will not load", async () => {
    fetchFrames.mockRejectedValue(new Error("network"));
    const { container } = render(<FrameStrip assetId="a1" onQueued={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("p")).toBeNull());
  });

  it("asks what is wrong before it will rebuild anything", async () => {
    show();
    await waitFor(() => expect(screen.getAllByText("Rebuild")).toHaveLength(3));
    fireEvent.click(screen.getAllByText("Rebuild")[1]!);
    expect(screen.getByText("Rebuild frame 2")).toBeTruthy();
    const button = screen.getByText("Rebuild this frame") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rebuilds the frame that was clicked, with the feedback typed", async () => {
    const { onQueued } = show();
    await waitFor(() => expect(screen.getAllByText("Rebuild")).toHaveLength(3));
    fireEvent.click(screen.getAllByText("Rebuild")[2]!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  too dark  " } });
    fireEvent.click(screen.getByText("Rebuild this frame"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("regenerate_frame", {
      p_asset_id: "a1",
      p_position: 3,
      p_feedback: "too dark",
    });
    expect(onQueued).toHaveBeenCalledWith(expect.stringContaining("frame 3"));
  });

  it("says the other frames carry over, because that is the point", async () => {
    show();
    await waitFor(() => expect(screen.getAllByText("Rebuild")).toHaveLength(3));
    fireEvent.click(screen.getAllByText("Rebuild")[0]!);
    expect(screen.getByText(/other 2 carry over/)).toBeTruthy();
  });

  it("reports a refusal rather than claiming it queued", async () => {
    rpc.mockResolvedValue({ error: { message: "Only an admin can regenerate a frame." } });
    const { onQueued, onError } = show();
    await waitFor(() => expect(screen.getAllByText("Rebuild")).toHaveLength(3));
    fireEvent.click(screen.getAllByText("Rebuild")[0]!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Rebuild this frame"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Only an admin can regenerate a frame."));
    expect(onQueued).not.toHaveBeenCalled();
  });
});
