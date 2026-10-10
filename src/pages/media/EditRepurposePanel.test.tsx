import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: "assignment-1", error: null })) }));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map([["client-1/raw.mp4", "https://example.test/raw.mp4"]]) }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    const data = table === "client_media_assets" ? [{ id: "raw-1", title: "Founder footage",
      brief_id: "brief-1", storage_path: "client-1/raw.mp4", edit_stage: "needs_edit", created_at: "2026-10-10" }]
      : table === "team_members" ? [{ id: "editor-1", name: "Taylor" }] : [];
    const chain = { select: () => chain, eq: () => chain, in: () => chain,
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
});
