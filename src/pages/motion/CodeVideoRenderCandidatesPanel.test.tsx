import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { rows, preview } = vi.hoisted(() => ({
  rows: { value: [] as Record<string, unknown>[] },
  preview: { value: new Map<string, string>() },
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  from: () => {
    const query = { select: () => query, eq: () => query, order: () => query,
      limit: async () => ({ data: rows.value, error: null }) };
    return query;
  },
} }));
vi.mock("../../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => preview.value,
}));

import { CodeVideoRenderCandidatesPanel } from "./CodeVideoRenderCandidatesPanel";

beforeEach(() => { rows.value = []; preview.value = new Map(); });

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
