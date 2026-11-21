import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { rows, preview } = vi.hoisted(() => ({
  rows: { value: [] as Record<string, unknown>[] },
  preview: { value: new Map<string, string>() },
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from: () => {
    let projectIds: string[] | null = null;
    const query = { select: () => query, eq: () => query, order: () => query,
      in: (column: string, values: string[]) => {
        if (column === "project_id") projectIds = values;
        return query;
      },
      limit: async () => ({ data: projectIds
        ? rows.value.filter((row) => projectIds!.includes(String(row.project_id)))
        : rows.value, error: null }) };
    return query;
  },
} }));
vi.mock("../../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => preview.value,
}));

import { CodeVideoRenderCandidatesPanel } from "./CodeVideoRenderCandidatesPanel";

beforeEach(() => { rows.value = []; preview.value = new Map(); });

it("keeps inline render candidates within the selected campaign projects", async () => {
  rows.value = [
    { id: "own", project_id: "project-1", aspect: "16:9", ir_version: 1,
      probe_result: "pass", verdict: "accepted", file_bytes: 1000000,
      storage_path: "own.mp4", file_sha256: "a".repeat(64), created_at: "2026-11-20" },
    { id: "other", project_id: "project-2", aspect: "9:16", ir_version: 1,
      probe_result: "pass", verdict: "accepted", file_bytes: 1000000,
      storage_path: "other.mp4", file_sha256: "b".repeat(64), created_at: "2026-11-20" },
  ];
  render(<CodeVideoRenderCandidatesPanel clientId="client-1"
    projectIds={["project-1"]} titles={new Map([["project-1", "Own video"]])} />);
  expect(await screen.findByText(/Own video · 16:9/)).toBeInTheDocument();
  expect(screen.queryByText(/9:16 · IR/)).not.toBeInTheDocument();
});

it("distinguishes a passed media probe from creative and human approval", async () => {
  rows.value = [{ id: "candidate-1", project_id: "project-1", aspect: "16:9",
    ir_version: 3, probe_result: "pass", verdict: "pending", file_bytes: 1234567,
    storage_path: "client/video/candidate.mp4", file_sha256: "a".repeat(64),
    attempt_id: "attempt-1", created_at: "2026-11-20", rejection_reason: null,
    media_probe: { width: 1920, height: 1080, duration_sec: 120 }, creative_review: null }];
  preview.value = new Map([["client/video/candidate.mp4", "https://example.test/signed"]]);
  const { container } = render(<CodeVideoRenderCandidatesPanel clientId="client-1"
    titles={new Map([["project-1", "An explainer"]])} />);
  expect(await screen.findByText(/An explainer · 16:9 · IR v3/)).toBeInTheDocument();
  expect(screen.getByText(/Media probe: pass · Creative review: pending/)).toBeInTheDocument();
  expect(screen.getByText(/A passed media probe is not creative or human approval/)).toBeInTheDocument();
  expect(container.querySelector("video")).toHaveAttribute("src", "https://example.test/signed");
  expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
});

it("shows a failed critic area and the sampled segment evidence", async () => {
  rows.value = [{ id: "candidate-2", project_id: "project-1", aspect: "9:16",
    ir_version: 4, probe_result: "pass", verdict: "rejected", file_bytes: 2000000,
    storage_path: "client/video/rejected.mp4", file_sha256: "b".repeat(64),
    attempt_id: "attempt-2", created_at: "2026-11-20",
    rejection_reason: "Contrast failed.",
    media_probe: { width: 1080, height: 1920, duration_sec: 60,
      has_audio: true, audio_integrated_lufs: -14.1,
      audio_true_peak_dbfs: -1.7, checks: [] },
    creative_review: { result: "fail", summary: "Contrast failed.",
      sampled_frames: 6,
      checks: [{ area: "contrast", verdict: "fail",
        reason: "Text is unreadable.", at_sec: 12 }],
      segments: [{ first_sec: 0.2, last_sec: 15.8,
        summary: "Contrast failed in opening scene." }] } }];
  render(<CodeVideoRenderCandidatesPanel clientId="client-1"
    titles={new Map([["project-1", "An explainer"]])} />);
  expect(await screen.findByText(/An explainer · 9:16 · IR v4/)).toBeInTheDocument();
  expect(screen.getByText(/contrast · fail at 12s: Text is unreadable/))
    .toBeInTheDocument();
  expect(screen.getByText(/Segment 1: 0.2s–15.8s/)).toBeInTheDocument();
});
