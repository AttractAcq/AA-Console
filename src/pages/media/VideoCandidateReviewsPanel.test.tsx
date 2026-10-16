import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, signPaths } = vi.hoisted(() => ({ from: vi.fn(), signPaths: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../lib/media", () => ({ signPaths }));

import { VideoCandidateReviewsPanel } from "./VideoCandidateReviewsPanel";

beforeEach(() => {
  vi.clearAllMocks();
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: [{
      id: "cut-1", client_id: "client-1", asset_id: "reel-1", job_id: "job-1",
      attempt: 2, render_path: "client-1/reel/candidate.mp4", verdict: "rejected",
      media_probe: { result: "fail", width: 1080, height: 1920, duration_sec: 25,
        checks: ["1 frozen interval of at least 2s detected."] },
      creative_review: { result: "fail", sampled_fps: 2, summary: "Opening action is missing.",
        checks: [{ area: "brief_execution", verdict: "fail", reason: "Action absent", at_sec: 1.5 }] },
      rejection_reason: "Opening action is missing.",
    }], error: null }),
  };
  from.mockReturnValue(query);
  signPaths.mockResolvedValue(new Map([["client-1/reel/candidate.mp4", "https://example.test/candidate.mp4"]]));
});

it("shows rejected candidate footage and the precise quality failure", async () => {
  render(<VideoCandidateReviewsPanel clientId="client-1" titles={new Map([["reel-1", "Consultation reel"]])} />);
  expect(await screen.findByText("Consultation reel · cut attempt 2")).toBeInTheDocument();
  expect(screen.getByText("Internal QA: rejected")).toBeInTheDocument();
  const video = screen.getByRole("region", { name: "Video quality reviews" }).querySelector("video");
  expect(video?.getAttribute("src")).toBe("https://example.test/candidate.mp4");
  await userEvent.click(screen.getByText("Inspect media and creative checks"));
  expect(screen.getByText("1 frozen interval of at least 2s detected.")).toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("brief execution · fail · 1.5s: Action absent");
});
