import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MediaAsset } from "../../lib/media";
import { TextDraftDialog } from "./TextDraftDialog";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("../../lib/useSignedPreviewPaths", () => ({ useSignedPreviewPaths: () => new Map() }));

it("reopens the working copy for the exact text asset, client and brief after an edit", async () => {
  let concept = { body: "A saved synthetic draft." };
  const query = {
    select: () => query, eq: vi.fn(() => query),
    single: async () => ({ data: { generation: { id: "generation", media_type: "text", concept } } }),
    order: async () => ({ data: [] }),
  };
  from.mockReturnValue(query);
  rpc.mockImplementation(async (name, args) => {
    expect(name).toBe("update_generation_concept");
    expect(args.p_generation_id).toBe("generation");
    concept = args.p_concept;
    return { error: null };
  });
  const asset = { id: "asset", client_id: "client", review_status: "pending" } as MediaAsset;
  const brief = { id: "brief", title: "Source", brief_ref: "QA-B1", body: "Brief content" };
  const open = () => render(<TextDraftDialog asset={asset} brief={brief} onClose={() => {}} />);
  const first = open();
  await screen.findByText(concept.body);
  expect(query.eq.mock.calls).toEqual(expect.arrayContaining([
    ["asset_id", asset.id], ["client_id", asset.client_id], ["generation.client_id", asset.client_id],
    ["generation.brief_id", brief.id], ["generation.media_type", "text"],
  ]));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Copy"), { target: { value: "Reviewed synthetic draft." } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  first.unmount();
  open();
  expect(await screen.findByText("Reviewed synthetic draft.")).toBeInTheDocument();
  expect(screen.getByText("Source brief · QA-B1")).toBeInTheDocument();
  expect(screen.getByText("Review state · pending")).toBeInTheDocument();
});
