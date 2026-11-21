import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));

import { DailyProductionOverview } from "./DailyProductionOverview";

function rows(data: unknown[]) {
  const query = {
    select: () => query, eq: () => query, in: () => query,
    order: () => query, limit: () => query,
    then: (resolve: (result: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return query;
}

it("shows exact daily demand and keeps workflow QA separate from human approval", async () => {
  from.mockImplementation((table: string) => table === "daily_packages"
    ? rows([{ id: "p1", run_id: "r1", package_day: "2026-11-16", platform: "instagram" }])
    : table === "workflow_runs"
      ? rows([{ id: "r1", workflow_version: "v6.daily.code_video.1",
        status: "running", blocker: "Render receipt changed." }])
      : table === "workflow_steps"
        ? rows([{ id: "s1", run_id: "r1", step_key: "reel_video",
          blocker: "Attached daily video Storage object changed." }])
      : rows([{ demand_id: "d1", run_id: "r1", piece_key: "static_a",
      destination: "instagram", media_type: "image", content_format: "single",
      produced: 2, rejected: 1, revised: 1, workflow_accepted: 1,
      human_approved: 0 }]));
  render(<MemoryRouter initialEntries={["/clients/c1"]}><Routes>
    <Route path="/clients/:clientId" element={<DailyProductionOverview />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText(/2026-11-16 · instagram · Code video/)).toBeInTheDocument();
  expect(screen.getByText(/Workflow: running · Held: Render receipt changed/)).toBeInTheDocument();
  expect(screen.getByText(/reel video: Attached daily video Storage object changed/)).toBeInTheDocument();
  expect(screen.getByText(/1 requested · 2 produced · 1 failed or rejected attempts · 1 revised · 1 passed workflow QA · 0 human approved/)).toBeInTheDocument();
});
