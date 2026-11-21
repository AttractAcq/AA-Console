import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash, webcrypto } from "node:crypto";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { records, rpc, signDownload } = vi.hoisted(() => ({
  records: { attachments: [] as Record<string, unknown>[],
    assets: [] as Record<string, unknown>[],
    thumbnails: [] as Record<string, unknown>[],
    candidates: [] as Record<string, unknown>[] },
  rpc: vi.fn(),
  signDownload: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  storage: { from: () => ({ createSignedUrl: signDownload }) },
  from: (table: string) => {
    let projectIds: string[] | null = null;
    const result = () => ({ data: table === "client_media_assets"
      ? records.assets : table === "video_project_thumbnail_attempts_v1"
        ? records.thumbnails : table === "video_project_render_candidates_v1"
          ? records.candidates : projectIds
            ? records.attachments.filter((row) => projectIds!.includes(String(row.project_id)))
            : records.attachments, error: null });
    const query = { select: () => query, eq: () => query,
      order: () => query, or: () => query, limit: async () => result(),
      in: (column: string, values: string[]) => {
        if (column === "project_id") projectIds = values;
        return query;
      }, then: (resolve: (value: ReturnType<typeof result>) => void) =>
        Promise.resolve(result()).then(resolve) };
    return query;
  },
} }));
vi.mock("../../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => new Map([
    ["client/video.mp4", "https://example.test/signed"],
    ["client/thumbnail.jpg", "https://example.test/thumbnail"],
    ["client/vertical.mp4", "https://example.test/vertical"],
  ]),
}));
vi.mock("../../components/VideoApprovalRoute", () => ({
  VideoApprovalRoute: ({ onFinalApprove }: { onFinalApprove: () => void }) =>
    <button type="button" onClick={onFinalApprove}>Finish video approval</button>,
}));

import { CodeVideoAttachmentsPanel } from "./CodeVideoAttachmentsPanel";

beforeEach(() => { rpc.mockReset(); signDownload.mockReset();
  vi.stubGlobal("crypto", webcrypto);
  records.attachments = []; records.assets = []; records.thumbnails = [];
  records.candidates = []; });
afterEach(() => vi.unstubAllGlobals());

function fileReceipt(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function mockDownload(bytes: Uint8Array) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
    arrayBuffer: async () => bytes.buffer }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified-video");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}

it("keeps inline attached videos within the selected campaign projects", async () => {
  records.attachments = [
    { id: "own-attachment", project_id: "project-1", ir_version: 1,
      first_candidate_id: "candidate-1", asset_id: "asset-1", attached_at: "2026-11-20" },
    { id: "other-attachment", project_id: "project-2", ir_version: 1,
      first_candidate_id: "candidate-2", asset_id: "asset-2", attached_at: "2026-11-20" },
  ];
  records.assets = [{ id: "asset-1", title: "Own asset", review_status: "pending",
    human_approved_at: null, storage_path: "own.mp4", render_path: "own.mp4" }];
  render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
    projectIds={["project-1"]} titles={new Map([["project-1", "Own video"]])} /></MemoryRouter>);
  expect(await screen.findByText(/Own video · IR v1/)).toBeInTheDocument();
  expect(screen.queryByText(/other-attachment/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Video project · IR v1/)).not.toBeInTheDocument();
});

it("shows an attached video as pending until the human approval route finishes", async () => {
  records.attachments = [{ id: "attachment-1", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-1",
    asset_id: "asset-1", attached_at: "2026-11-20" }];
  records.assets = [{ id: "asset-1", title: "Explainer",
    review_status: "pending", human_approved_at: null,
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  records.candidates = [{ id: "candidate-1", project_id: "project-1",
    ir_version: 2, aspect: "16:9", verdict: "accepted", probe_result: "pass",
    storage_path: "client/video.mp4", file_sha256: "a".repeat(64) }];
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

it("shows the filed thumbnail and verifies the private MP4 before download", async () => {
  const file = fileReceipt("verified video bytes");
  records.attachments = [{ id: "attachment-3", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-3",
    thumbnail_attempt_id: "thumb-3", asset_id: "asset-3",
    attached_at: "2026-11-21" }];
  records.assets = [{ id: "asset-3", title: "Explainer",
    review_status: "pending", human_approved_at: null,
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  records.thumbnails = [{ id: "thumb-3", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-3",
    state: "filed", storage_path: "client/thumbnail.jpg",
    file_sha256: "a".repeat(64), file_bytes: 2048 }];
  records.candidates = [{ id: "candidate-3", project_id: "project-1",
    ir_version: 2, aspect: "16:9", verdict: "accepted", probe_result: "pass",
    storage_path: "client/video.mp4", file_sha256: file.sha256 }];
  signDownload.mockResolvedValue({ data: {
    signedUrl: "https://example.test/download" }, error: null });
  mockDownload(file.bytes);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    const user = userEvent.setup();
    render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
      titles={new Map()} /></MemoryRouter>);
    expect(await screen.findByRole("img", { name: "Thumbnail for Explainer" }))
      .toHaveAttribute("src", "https://example.test/thumbnail");
    await user.click(screen.getByRole("button", { name: "Download verified MP4" }));
    expect(signDownload).toHaveBeenCalledWith("client/video.mp4",300);
    expect(await screen.findByText(/Verified Explainer.mp4/)).toBeInTheDocument();
    expect(click).toHaveBeenCalledOnce();
  } finally { click.mockRestore(); }
});

it("exposes accepted aspect files with exact IDs and separate review wording", async () => {
  const file = fileReceipt("vertical derivative bytes");
  records.attachments = [{ id: "attachment-4", project_id: "project-1",
    ir_version: 5, first_candidate_id: "candidate-landscape",
    asset_id: "asset-4", attached_at: "2026-11-21" }];
  records.assets = [{ id: "asset-4", title: "Explainer",
    review_status: "approved", human_approved_at: "2026-11-21",
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  records.candidates = [
    { id: "candidate-landscape", project_id: "project-1", ir_version: 5,
      aspect: "16:9", verdict: "accepted", probe_result: "pass",
      storage_path: "client/video.mp4", file_sha256: "a".repeat(64) },
    { id: "candidate-vertical", project_id: "project-1", ir_version: 5,
      aspect: "9:16", verdict: "accepted", probe_result: "pass",
      storage_path: "client/vertical.mp4", file_sha256: file.sha256 },
    { id: "older", project_id: "project-1", ir_version: 4,
      aspect: "1:1", verdict: "accepted", probe_result: "pass",
      storage_path: "client/old.mp4", file_sha256: "c".repeat(64) },
  ];
  signDownload.mockResolvedValue({ data: { signedUrl: "https://example.test/download" },
    error: null });
  mockDownload(file.bytes);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    const user = userEvent.setup();
    render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
      titles={new Map()} /></MemoryRouter>);
    expect(await screen.findByText(/9:16 · derivative/)).toBeInTheDocument();
    expect(screen.getByText(/human asset decision above applies to the first aspect/))
      .toBeInTheDocument();
    expect(screen.queryByText(/1:1 · derivative/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download verified 9:16 MP4" }));
    expect(signDownload).toHaveBeenCalledWith("client/vertical.mp4", 300);
    expect(await screen.findByText(/Verified Explainer-9x16.mp4/))
      .toBeInTheDocument();
    expect(click).toHaveBeenCalledOnce();
  } finally { click.mockRestore(); }
});

it("holds download and human approval when the first-aspect receipt is missing", async () => {
  records.attachments = [{ id: "attachment-5", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-missing",
    asset_id: "asset-5", attached_at: "2026-11-21" }];
  records.assets = [{ id: "asset-5", title: "Explainer",
    review_status: "pending", human_approved_at: null,
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
    titles={new Map()} /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "First-aspect candidate receipt is unavailable");
  expect(screen.queryByRole("button", { name: "Download verified MP4" }))
    .not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Finish video approval" }))
    .not.toBeInTheDocument();
});

it("refuses changed Storage bytes instead of offering a false exact download", async () => {
  const file = fileReceipt("reviewed video bytes");
  records.attachments = [{ id: "attachment-6", project_id: "project-1",
    ir_version: 2, first_candidate_id: "candidate-6",
    asset_id: "asset-6", attached_at: "2026-11-21" }];
  records.assets = [{ id: "asset-6", title: "Explainer",
    review_status: "approved", human_approved_at: "2026-11-21",
    storage_path: "client/video.mp4", render_path: "client/video.mp4" }];
  records.candidates = [{ id: "candidate-6", project_id: "project-1",
    ir_version: 2, aspect: "16:9", verdict: "accepted", probe_result: "pass",
    storage_path: "client/video.mp4", file_sha256: file.sha256 }];
  signDownload.mockResolvedValue({ data: {
    signedUrl: "https://example.test/download" }, error: null });
  mockDownload(new TextEncoder().encode("changed video bytes"));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    const user = userEvent.setup();
    render(<MemoryRouter><CodeVideoAttachmentsPanel clientId="client-1"
      titles={new Map()} /></MemoryRouter>);
    await user.click(await screen.findByRole("button",
      { name: "Download verified MP4" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match its filed SHA-256 receipt");
    expect(click).not.toHaveBeenCalled();
  } finally { click.mockRestore(); }
});
