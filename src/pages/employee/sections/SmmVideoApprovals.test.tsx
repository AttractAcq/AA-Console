import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ error: null })) }));
vi.mock("../../../components/VideoApprovalRoute", () => ({
  VideoApprovalRoute: ({ assetId, onFinalApprove }: { assetId: string; onFinalApprove: () => void }) =>
    <button type="button" onClick={onFinalApprove}>Approve {assetId}</button>,
}));
vi.mock("../../../lib/media", () => ({ signPaths: async () => new Map([
  ["client-1/reel.mp4", "https://example.test/reel.mp4"],
  ["client-1/cut.mp4", "https://example.test/cut.mp4"],
]) }));
vi.mock("../../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    const data = table === "client_assignments"
      ? [{ client_id: "client-1", clients: { name: "Acme" } }]
      : table === "client_media_assets" ? [
        { id: "reel-1", client_id: "client-1", title: "Reel", content_format: "reel",
          storage_path: "client-1/still.png", render_path: "client-1/reel.mp4", created_at: "2026-10-10" },
        { id: "cut-1", client_id: "client-1", title: "Interview", content_format: "single",
          storage_path: "client-1/cut.mp4", render_path: null, created_at: "2026-10-10" },
      ] : [{ id: "slot-1", asset_id: "reel-1" }];
    const chain = { select: () => chain, eq: (column: string) =>
      table === "content_slots" && column === "stage" ? Promise.resolve({ data, error: null }) : chain,
      is: () => table === "client_assignments" ? Promise.resolve({ data, error: null }) : chain,
      in: () => chain, order: () => Promise.resolve({ data, error: null }) };
    return chain;
  },
} }));

import { SmmVideoApprovals } from "./SmmVideoApprovals";

beforeEach(() => rpc.mockClear());

it("routes an engine reel through approve_slot and an ordinary cut through asset review", async () => {
  render(<SmmVideoApprovals memberId="smm-1" />);
  expect(await screen.findByLabelText("Review Reel")).toHaveAttribute("src", "https://example.test/reel.mp4");
  await userEvent.click(screen.getByRole("button", { name: "Approve reel-1" }));
  expect(rpc).toHaveBeenCalledWith("approve_slot", { p_slot_id: "slot-1" });
  await userEvent.click(screen.getByRole("button", { name: "Approve cut-1" }));
  expect(rpc).toHaveBeenCalledWith("review_media_asset", { p_asset_id: "cut-1", p_decision: "approved" });
});
