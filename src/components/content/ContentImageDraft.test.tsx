import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ContentAssetTable } from "./ContentAssetTable";

vi.mock("../../lib/media", () => ({
  fetchClientAssets: async () => [{ id: "draft", client_id: "client", media_type: "image",
    title: "Illustration", brief_id: "brief", review_status: "pending", storage_path: "client/generated/image.png" }],
}));
vi.mock("../../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => new Map([["client/generated/image.png", "https://example.invalid/preview"]]),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: () => {
    const query = { select: () => query, eq: () => query, in: async () => ({
      data: [{ id: "brief", title: "Source brief", brief_ref: "QA fixture" }], error: null,
    }) };
    return query;
  } },
}));
vi.mock("../briefs/BriefDetailModal", () => ({
  BriefDetailModal: ({ brief }: { brief: { title: string } | null }) => brief ? <p>{brief.title}</p> : null,
}));

it("reopens the pending image at its draft URL with the exact source brief", async () => {
  render(<MemoryRouter initialEntries={["/client?tab=create&draft=draft"]}>
    <Routes><Route path="/:clientId" element={<ContentAssetTable approved={false} />} /></Routes>
  </MemoryRouter>);
  const panel = within(await screen.findByRole("region", { name: "Image draft" }));
  expect(panel.getByRole("img", { name: "Illustration" })).toHaveAttribute("src", "https://example.invalid/preview");
  expect(panel.getByText(/pending/)).toBeInTheDocument();
  fireEvent.click(panel.getByRole("button", { name: "QA fixture" }));
  expect(await screen.findByText("Source brief")).toBeInTheDocument();
});
