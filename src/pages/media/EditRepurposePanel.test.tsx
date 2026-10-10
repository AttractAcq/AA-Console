import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, upload, remove, scenario } = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: "assignment-1", error: null })),
  upload: vi.fn(async () => ({ error: null })),
  remove: vi.fn(async () => ({ error: null })),
  scenario: { stage: "needs_edit", request: null } as { stage: string; request: Record<string, unknown> | null },
}));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map([["client-1/raw.mp4", "https://example.test/raw.mp4"]]) }));
vi.mock("./VideoRepurposePanel", () => ({ VideoRepurposePanel: () => null }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  storage: { from: () => ({ upload, remove }) },
  from: (table: string) => {
    const data = table === "client_media_assets" ? [{ id: "raw-1", title: "Founder footage",
      brief_id: "brief-1", storage_path: "client-1/raw.mp4", edit_stage: scenario.stage, created_at: "2026-10-10" }]
      : table === "team_members" ? [{ id: "editor-1", name: "Taylor" }]
        : table === "video_source_edit_requests" && scenario.request ? [scenario.request] : [];
    const chain = { select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
      order: () => Promise.resolve({ data, error: null }) };
    return chain;
  },
} }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

import { EditRepurposePanel } from "./EditRepurposePanel";

describe("human video edit intake", () => {
  beforeEach(() => { scenario.stage = "needs_edit"; scenario.request = null; rpc.mockClear(); });
  it("queues an AI edit with explicit direction and controlled effects", async () => {
    render(<MemoryRouter><EditRepurposePanel /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Edit with AI" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Editing direction" }),
      "Keep the strongest answer and remove the long pauses.");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Crop / aspect" }), "square");
    await userEvent.click(screen.getByRole("checkbox", { name: "Animated title" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate AI edit" }));
    expect(rpc).toHaveBeenCalledWith("request_source_video_edit", {
      p_asset_id: "raw-1", p_direction: "Keep the strongest answer and remove the long pauses.",
      p_aspect: "square", p_remove_pauses: true, p_captions: true,
      p_animated_title: true, p_brand_treatment: "on_brand", p_feel: "balanced",
    });
  });
  it("offers revision of an unfinalized AI cut with its prior settings", async () => {
    scenario.stage = "edited";
    scenario.request = { id: "edit-1", source_asset_id: "raw-1", output_asset_id: null,
      direction: "Keep the useful explanation and remove pauses.", aspect: "square",
      remove_pauses: true, captions: true, animated_title: false,
      brand_treatment: "on_brand", feel: "calm", status: "completed",
      error: null, edit_plan: null, created_at: "2026-10-10" };
    render(<MemoryRouter><EditRepurposePanel /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Revise AI edit" }));
    expect(screen.getByRole("textbox", { name: "Editing direction" })).toHaveValue(
      "Keep the useful explanation and remove pauses.");
    expect(screen.getByRole("combobox", { name: "Crop / aspect" })).toHaveValue("square");
    expect(screen.queryByRole("button", { name: "Send to editor" })).not.toBeInTheDocument();
  });
  it("previews source footage and assigns an editor before approval", async () => {
    render(<MemoryRouter><EditRepurposePanel /></MemoryRouter>);
    expect(await screen.findByLabelText("Source footage for Founder footage")).toHaveAttribute(
      "src", "https://example.test/raw.mp4",
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Editor for Founder footage" }), "editor-1");
    await userEvent.click(screen.getByRole("button", { name: "Send to editor" }));
    expect(rpc).toHaveBeenCalledWith("request_human_video_edit", {
      p_asset_id: "raw-1", p_member_id: "editor-1",
    });
  });
  it("can accept delivered footage as the finished cut without assigning an editor", async () => {
    rpc.mockClear();
    render(<MemoryRouter><EditRepurposePanel /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Use as finished cut" }));
    expect(rpc).toHaveBeenCalledWith("accept_video_as_finished", { p_asset_id: "raw-1" });
  });
  it("uploads a supplied video with explicit source and rights", async () => {
    rpc.mockClear(); upload.mockClear();
    render(<MemoryRouter><EditRepurposePanel /></MemoryRouter>);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("Choose video or drop it here"),
      new File(["video"], "founder-clip.mp4", { type: "video/mp4" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Video source" }), "client_supplied");
    await user.selectOptions(screen.getByRole("combobox", { name: "Usage rights" }), "client_owned");
    await user.click(screen.getByRole("button", { name: "Add to Edit / Repurpose" }));
    expect(upload).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("intake_video_for_edit", expect.objectContaining({
      p_client_id: "client-1", p_title: "founder clip", p_format: "reel",
      p_source: "client_supplied", p_rights: "client_owned",
    }));
  });
});
