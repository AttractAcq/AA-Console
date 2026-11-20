import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const { records, rpc } = vi.hoisted(() => ({
  records: { attachments: [] as Record<string, unknown>[],
    assets: [] as Record<string, unknown>[] },
  rpc: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    const query = { select: () => query, eq: () => query,
      order: () => query, limit: async () => ({
        data: records.attachments, error: null }),
      in: async () => ({ data: table === "client_media_assets"
        ? records.assets : [], error: null }) };
    return query;
  },
} }));
vi.mock("../../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => new Map([["client/video.mp4", "https://example.test/signed"]]),
}));
vi.mock("../../components/VideoApprovalRoute", () => ({
  VideoApprovalRoute: ({ onFinalApprove }: { onFinalApprove: () => void }) =>
    <button type="button" onClick={onFinalApprove}>Finish video approval</button>,
}));

import { CodeVideoAttachmentsPanel } from "./CodeVideoAttachmentsPanel";

beforeEach(() => { rpc.mockReset();
  records.attachments = []; records.assets = []; });

it("shows an attached video as pending until the human approval route finishes", async () => {
  records.attachments = [{ id: "attachment-1", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-1",
    asset_id: "asset-1", attached_at: "2026-11-20" }];
  records.assets = [{ id: "asset-1", title: "Explainer",
    review_status: "pending", human_approved_at: null,
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  rpc.mockResolvedValue({ error: null });
  const user = userEvent.setup();
  render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
    titles={new Map([["project-1", "Reviewed explainer"]])} /></MemoryRouter>);
  expect(await screen.findByText(/Reviewed explainer · IR v2/)).toBeInTheDocument();
  expect(screen.getByText(/awaiting human approval/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Approval Inbox" }))
    .toHaveAttribute("href", "/clients/client-1/delivery/approval-inbox?tab=assets");
  await user.click(screen.getByRole("button", { name: "Finish video approval" }));
  expect(rpc).toHaveBeenCalledWith("review_media_asset",
    { p_asset_id: "asset-1", p_decision: "approved" });
});

it("does not offer another approval action for an approved asset", async () => {
  records.attachments = [{ id: "attachment-2", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-2",
    asset_id: "asset-2", attached_at: "2026-11-20" }];
  records.assets = [{ id: "asset-2", title: "Explainer",
    review_status: "approved", human_approved_at: "2026-11-20",
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
    titles={new Map()} /></MemoryRouter>);
  expect(await screen.findByText(/human approved/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Finish video approval" }))
    .not.toBeInTheDocument();
});
