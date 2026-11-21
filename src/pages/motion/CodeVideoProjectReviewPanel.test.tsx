import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => {
  const rows: Record<string, unknown[]> = {
    video_scenes: [{ id: "scene-1", scene_key: "s01",
      component: "TitleCard", narration: "Revised narration.",
      audio_path: null, duration_sec: null, locked: false }],
    video_project_prerender_attempts_v1: [{ id: "attempt-1",
      ir_version: 1, state: "decided", result: "fail",
      claimed_at: "2026-11-21T10:00:00Z", decided_at: "2026-11-21T10:01:00Z",
      still_usd: 0.009, model_usd: 0.012,
      report: { checks: [{ area: "narration_visual_match", verdict: "fail",
        sceneId: "s01", reason: "Words do not match the visual." }],
        patch: [{ op: "shorten_text", sceneId: "s01",
          path: "narration", value: "Revised narration." }] } }],
    video_project_visual_patches_v1: [],
    video_project_narration_patches_v1: [{ attempt_id: "attempt-1",
      from_ir_version: 1, to_ir_version: 2, changed_scene_ids: ["s01"] }],
  };
  return { from: vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query,
      order: () => query, limit: () => query,
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({
        data: rows[table], error: null }).then(resolve) };
    return query;
  }) };
});
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));

import { CodeVideoProjectReviewPanel } from "./CodeVideoProjectReviewPanel";

it("shows the failed exact critic decision and pending replacement audio", async () => {
  render(<CodeVideoProjectReviewPanel clientId="client-1"
    projectId="project-1" stage="timing" />);
  expect(await screen.findByText(/s01 · TitleCard · changed by critic/))
    .toBeInTheDocument();
  expect(screen.getByText("Audio: pending")).toBeInTheDocument();
  expect(screen.getByText(/narration visual match · fail · s01/))
    .toHaveTextContent("Words do not match the visual.");
  expect(screen.getByText(/Revision committed: v1 → v2/))
    .toHaveTextContent("scenes s01");
  expect(from).toHaveBeenCalledWith("video_project_prerender_attempts_v1");
});
