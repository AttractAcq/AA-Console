import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("./ImageLibraryPanel", () => ({ ImageLibraryPanel: () => <p>Image library</p> }));
vi.mock("./VideoLibraryPanel", () => ({ VideoLibraryPanel: () => <p>Video library</p> }));
vi.mock("./ReelShotsPanel", () => ({ ReelShotsPanel: () => <p>Reel shots</p> }));
vi.mock("./CopyLibraryPanel", () => ({ CopyLibraryPanel: () => <p>Copy library</p> }));
vi.mock("./StoryLibraryPanel", () => ({ StoryLibraryPanel: () => <p>Story library</p> }));
vi.mock("./CarouselLibraryPanel", () => ({ CarouselLibraryPanel: () => <p>Carousel library</p> }));

import { ContentAssetsPanel } from "./ContentAssetsPanel";

it("groups all six existing libraries without dropping their views", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={["/content?view=v2&tab=assets"]}><ContentAssetsPanel /></MemoryRouter>);
  const expected: [string, string][] = [
    ["Images", "Image library"], ["Videos", "Video library"], ["Reel Shots", "Reel shots"],
    ["Copy", "Copy library"], ["Stories", "Story library"], ["Carousels", "Carousel library"],
  ];
  for (const [tab, body] of expected) {
    await user.click(screen.getByRole("tab", { name: tab }));
    expect(screen.getByText(body)).toBeInTheDocument();
  }
});
