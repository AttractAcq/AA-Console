import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("./ContentAssetTable", () => ({
  ContentAssetTable: ({ approved }: { approved: boolean }) => <p>{approved ? "Approved assets" : "Awaiting approval"}</p>,
}));
vi.mock("../../pages/media/ImageLibraryPanel", () => ({ ImageLibraryPanel: () => <p>Image library</p> }));
vi.mock("../../pages/media/VideoLibraryPanel", () => ({ VideoLibraryPanel: () => <p>Video library</p> }));
vi.mock("../../pages/media/ReelShotsPanel", () => ({ ReelShotsPanel: () => <p>Reel shots</p> }));
vi.mock("../../pages/media/CopyLibraryPanel", () => ({ CopyLibraryPanel: () => <p>Copy library</p> }));
vi.mock("../../pages/media/StoryLibraryPanel", () => ({ StoryLibraryPanel: () => <p>Story library</p> }));
vi.mock("../../pages/media/CarouselLibraryPanel", () => ({ CarouselLibraryPanel: () => <p>Carousel library</p> }));

import { ContentAssetsWorkspace } from "./ContentAssetsWorkspace";

function Query() {
  return <span data-testid="query">{useLocation().search}</span>;
}

function open(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/assets"
          element={<><ContentAssetsWorkspace /><Query /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

it("offers the approved table and all six of v1's libraries", async () => {
  const user = userEvent.setup();
  open("/assets");
  expect(screen.getByText("Approved assets")).toBeInTheDocument();
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Approved", "Images", "Videos", "Reel Shots", "Copy", "Stories", "Carousels",
  ]);

  // Each one is reachable, and none of them is the approved table.
  for (const [name, text] of [
    ["Images", "Image library"], ["Videos", "Video library"],
    ["Reel Shots", "Reel shots"], ["Copy", "Copy library"],
    ["Stories", "Story library"], ["Carousels", "Carousel library"],
  ]) {
    await user.click(screen.getByRole("button", { name }));
    expect(screen.getByText(text!)).toBeInTheDocument();
    expect(screen.queryByText("Approved assets")).not.toBeInTheDocument();
  }
});

it("puts the open library in the query, and leaves it out for the approved table", async () => {
  const user = userEvent.setup();
  open("/assets");
  await user.click(screen.getByRole("button", { name: "Reel Shots" }));
  expect(screen.getByTestId("query").textContent).toBe("?tab=assets&library=reel-shots");
  await user.click(screen.getByRole("button", { name: "Approved" }));
  expect(screen.getByTestId("query").textContent).toBe("?tab=assets");
  expect(screen.getByText("Approved assets")).toBeInTheDocument();
});

it("opens the library a v1 tab link names", () => {
  // `?tab=reel-shots` was a v1 tab of Content Production Factory. The ids are
  // kept, so the link needs no translation.
  open("/assets?tab=reel-shots");
  expect(screen.getByText("Reel shots")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reel Shots" })).toHaveAttribute("aria-pressed", "true");
});

it("falls back to the approved table when the query names nothing it has", () => {
  open("/assets?library=sculptures");
  expect(screen.getByText("Approved assets")).toBeInTheDocument();
});
