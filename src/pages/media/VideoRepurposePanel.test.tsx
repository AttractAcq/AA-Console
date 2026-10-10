import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: "new-id", error: null })) }));
vi.mock("../../lib/media", () => ({ signPaths: async () =>
  new Map([["client-1/source.mp4", "https://example.test/source.mp4"]]) }));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    const data = table === "client_media_assets" ? [{ id: "source-1", title: "Founder interview",
      storage_path: "client-1/source.mp4", render_path: null,
      edit_stage: "needs_edit", review_status: "pending" }]
      : table === "video_repurpose_requests" ? [{ id: "request-1", source_asset_id: "source-1",
        direction: "Find a clear quote", status: "completed", error: null,
        candidates: [{ kind: "quote_image", title: "Simple process", reason: "Clear line",
          start_sec: 4, end_sec: 8, exact_quote: "We made the process simpler." }],
        created_at: "2026-10-10" }] : [];
    const chain = { select: () => chain, eq: () => chain, order: () => chain,
      limit: async () => ({ data, error: null }),
      in: async () => ({ data, error: null }) };
    return chain;
  },
} }));

import { VideoRepurposePanel } from "./VideoRepurposePanel";

it("creates a draft idea from an evidenced quote candidate", async () => {
  render(<MemoryRouter><VideoRepurposePanel clientId="client-1" /></MemoryRouter>);
  expect(await screen.findByText("We made the process simpler.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Send to Ideation" }));
  expect(rpc).toHaveBeenCalledWith("create_video_repurpose_idea", {
    p_request_id: "request-1", p_candidate_index: 1, p_target_platform: "instagram",
  });
});
