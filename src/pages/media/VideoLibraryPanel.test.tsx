import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, useParams, setSearchParams } = vi.hoisted(() => ({
  from: vi.fn(), useParams: vi.fn(), setSearchParams: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({
  useParams,
  useSearchParams: () => [new URLSearchParams(), setSearchParams],
}));
// The library itself has its own tests. This is about what happens when a
// reel is in production and the shelf is otherwise empty.
vi.mock("../../components/MediaLibrary", () => ({
  MediaLibrary: ({ mediaType }: { mediaType: string }) => <div>library:{mediaType}</div>,
}));

import { VideoLibraryPanel } from "./VideoLibraryPanel";

function withReelCount(count: number) {
  const query = {
    select: () => query,
    eq: () => query,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ count, error: null }).then(resolve, reject),
  };
  from.mockReturnValue(query);
  return render(<VideoLibraryPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("a reel in production is not silently absent", () => {
  it("says how many there are and where they went", async () => {
    withReelCount(2);
    expect(await screen.findByText(/2 reels are in production/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reel shots" })).toBeInTheDocument();
    // The library still renders underneath; the note is an addition, not a takeover.
    expect(screen.getByText("library:video")).toBeInTheDocument();
  });

  it("reads correctly for one", async () => {
    withReelCount(1);
    expect(await screen.findByText(/One reel is in production/)).toBeInTheDocument();
    expect(screen.getByText(/It is\s+reviewed shot by shot/)).toBeInTheDocument();
  });

  it("stays quiet when there are none", async () => {
    withReelCount(0);
    await screen.findByText("library:video");
    expect(screen.queryByText(/in production/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reel shots" })).toBeNull();
  });

  it("takes you to the tab that does show them", async () => {
    withReelCount(1);
    await userEvent.click(await screen.findByRole("button", { name: "Reel shots" }));
    await waitFor(() => expect(setSearchParams).toHaveBeenCalledWith({ tab: "reel-shots" }));
  });

  it("does not promise the reel will turn up here once it is finished", async () => {
    // It will not. An assembled reel is still content_format 'reel' and still
    // filtered out, so softening this copy into a reassurance would bury a
    // real gap rather than close it.
    withReelCount(1);
    const note = await screen.findByText(/One reel is in production/);
    expect(note.textContent).not.toMatch(/once|when .*(finished|assembled|ready)|will appear|later/i);
  });
});
