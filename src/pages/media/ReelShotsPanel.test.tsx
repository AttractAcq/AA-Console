import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();

vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: { from: (...args: unknown[]) => from(...args), rpc: vi.fn() },
}));

import { ReelShotsPanel } from "./ReelShotsPanel";

const shot = JSON.stringify({
  beat: "Name the mechanism",
  duration_sec: 3,
  motion_preset: "pending",
  shot_source_kind: "ai_generated",
});

function chain(result: unknown) {
  const query = {
    select: () => query,
    eq: () => query,
    or: () => query,
    is: () => query,
    in: () => query,
    order: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

beforeEach(() => {
  from.mockReset();
  from.mockImplementation((table: string) => {
    if (table === "client_briefs") {
      return chain({
        data: [
          {
            id: "brief-1",
            title: "How it works",
            brief_ref: "BR-9",
            status: "approved",
            content_format: "reel",
            format_code: "F6",
            media_type: "video",
            frame_plan: [shot],
          },
        ],
        error: null,
      });
    }
    if (table === "client_media_assets") return chain({ data: [], error: null });
    if (table === "client_media_frames") return chain({ data: [], error: null });
    throw new Error(table);
  });
});

describe("ReelShotsPanel", () => {
  it("loads the reel brief and shows the shot", async () => {
    render(<ReelShotsPanel />);
    await waitFor(() => expect(screen.getByText("Name the mechanism")).toBeInTheDocument());
    expect(from).toHaveBeenCalledWith("client_briefs");
    expect(screen.getByText(/Nothing to approve until a master exists/i)).toBeInTheDocument();
  });
});
