import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { restore, query } = vi.hoisted(() => ({
  restore: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../lib/contentChain", () => ({
  fetchArchive: vi.fn().mockResolvedValue([]),
  matchesSearch: vi.fn(),
  stageLabel: vi.fn(),
}));
vi.mock("../../lib/contentRecords", () => ({ setContentArchived: restore }));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: query },
}));
vi.mock("./ChainDetailModal", () => ({ ChainDetailModal: () => null }));

import { ContentArchivePanel } from "./ContentArchivePanel";

const records = [
  { id: "idea-1", client_id: "client-1", record_kind: "idea", reference: null,
    title: "Unsuitable idea", media_type: "image", status: "rejected",
    archived_at: "2026-11-18T00:00:00Z", detail: "Reason retained", brief_id: null },
  { id: "asset-1", client_id: "client-1", record_kind: "asset", reference: "AA-42",
    title: "Alternate cut", media_type: "video", status: "pending",
    archived_at: "2026-11-18T00:00:00Z", detail: null, brief_id: "brief-1" },
];

function show() {
  return render(
    <MemoryRouter initialEntries={["/clients/client-1/archive"]}>
      <Routes>
        <Route path="/clients/:clientId/archive" element={<ContentArchivePanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  restore.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockImplementation(() => ({
    select: () => ({
      eq: (column: string, value: string) => {
        expect(column).toBe("client_id");
        expect(value).toBe("client-1");
        return { order: () => Promise.resolve({ data: records, error: null }) };
      },
    }),
  }));
});

describe("Content Archive loose records", () => {
  it("shows archived ideas and assets outside completed chains and restores the exact record", async () => {
    show();
    expect(await screen.findByText("Unsuitable idea")).toBeTruthy();
    expect(screen.getByText("Alternate cut")).toBeTruthy();
    expect(screen.getByText("Reason retained")).toBeTruthy();
    expect(screen.getByText("AA-42")).toBeTruthy();
    expect(query).toHaveBeenCalledWith("content_archive_unlinked");

    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    await waitFor(() => expect(restore).toHaveBeenCalledWith("idea", "idea-1", false));
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[1]);
    await waitFor(() => expect(restore).toHaveBeenCalledWith("asset", "asset-1", false));
  });

  it("keeps the archived record visible when restoring fails", async () => {
    restore.mockRejectedValueOnce(new Error("Restore denied"));
    show();
    expect(await screen.findByText("Unsuitable idea")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Restore denied");
    expect(screen.getByText("Unsuitable idea")).toBeTruthy();
  });
});
