import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();

vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => from(...args),
    rpc: vi.fn(),
    // The panel signs the finished cuts so the grid can play them. Without
    // this the whole panel falls into its error path, which is how a missing
    // storage stub reads as "the cut is not on file".
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}`, error: null })),
          error: null,
        }),
      }),
    },
  },
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

let assets: unknown[] = [];
let frames: unknown[] = [];
let editJobs: unknown[] = [];

beforeEach(() => {
  assets = [];
  frames = [];
  editJobs = [];
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
    if (table === "client_media_assets") return chain({ data: assets, error: null });
    if (table === "client_media_frames") return chain({ data: frames, error: null });
    if (table === "agent_jobs") return chain({ data: editJobs, error: null });
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

  it("offers the cut on a master whose clips are on file", async () => {
    // Migration 141 gave the console request_video_edit and nothing called
    // it. This is the call.
    assets = [
      { id: "asset-1", brief_id: "brief-1", title: "How it works", ref_number: "MA-1", review_status: "approved", render_path: null },
    ];
    frames = [
      {
        asset_id: "asset-1",
        position: 1,
        storage_path: "stills/1.png",
        caption: null,
        beat: "Name the mechanism",
        duration_sec: 3,
        motion_preset: "pending",
        clip_path: "clips/1.mp4",
        shot_source_kind: "ai_generated",
        provider_job_id: "hf-1",
      },
    ];
    render(<ReelShotsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: /cut the reel/i })).toBeInTheDocument());
    expect(from).toHaveBeenCalledWith("agent_jobs");
    expect(screen.getByText("All 1 clips on file.")).toBeInTheDocument();
  });

  it("does not offer a second cut while one is running", async () => {
    assets = [
      { id: "asset-1", brief_id: "brief-1", title: "How it works", ref_number: "MA-1", review_status: "approved", render_path: null },
    ];
    editJobs = [{ input_id: "asset-1", status: "running", error: null }];
    render(<ReelShotsPanel />);
    await waitFor(() => expect(screen.getByText("Being cut now.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /cut the reel/i })).not.toBeInTheDocument();
  });

  it("says the cut is on file once one exists, and plays it", async () => {
    assets = [
      { id: "asset-1", brief_id: "brief-1", title: "How it works", ref_number: "MA-1", review_status: "approved", render_path: "cuts/a.mp4" },
    ];
    render(<ReelShotsPanel />);
    await waitFor(() => expect(screen.getByText("Cut on file.")).toBeInTheDocument());

    // "Cut on file" with no way to watch it is a claim a reviewer has to
    // take on trust.
    const player = document.querySelector("video");
    expect(player).not.toBeNull();
    expect(player!.getAttribute("src")).toBe("https://signed/cuts/a.mp4");
  });

  it("offers no player for a reel that has not been cut", async () => {
    assets = [
      { id: "asset-1", brief_id: "brief-1", title: "How it works", ref_number: "MA-1", review_status: "approved", render_path: null },
    ];
    render(<ReelShotsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: /cut the reel/i })).toBeInTheDocument());
    expect(document.querySelector("video")).toBeNull();
  });
});
