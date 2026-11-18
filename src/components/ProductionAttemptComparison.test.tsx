import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, eq } = vi.hoisted(() => ({ from: vi.fn(), eq: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../lib/useSignedPreviewPaths", () => ({
  useSignedPreviewPaths: () => new Map([["client-1/candidate.png", "https://signed.example/candidate"]]),
}));

import { ProductionAttemptComparison } from "./ProductionAttemptComparison";

beforeEach(() => {
  from.mockReset(); eq.mockReset();
  from.mockImplementation((table: string) => {
    const data = table === "production_attempt_timing_v8" ? [{
      attempt_id: "attempt-1", attempt_kind: "human_delivery", attempt_status: "delivered",
      asset_id: "asset-1", cost_usd: null, created_at: "2026-11-18T09:00:00Z",
      revised: true, human_review_status: "pending", accepted_workflow_output: false,
      started_at: "2026-11-18T08:00:00Z", finished_at: "2026-11-18T09:00:00Z",
      timing_basis: "assignment to delivery", failure_reason: null,
    }] : [{ id: "asset-1", title: "Candidate one", media_type: "image",
      storage_path: "client-1/candidate.png", render_path: null }];
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { eq(field, value); return query; },
      in: () => query, order: () => query,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve),
    };
    return query;
  });
});

it("shows an exact request's human candidate and preserves unknown cost", async () => {
  render(<ProductionAttemptComparison clientId="client-1" demandId="demand-1" count={1} />);
  await userEvent.click(screen.getByRole("button", { name: "Compare attempts" }));
  expect(await screen.findByText(/human delivery · delivered · revision/)).toBeInTheDocument();
  expect(screen.getByText(/Cost unknown · Human review pending · Workflow QA not accepted/)).toBeInTheDocument();
  expect(screen.getByText("assignment to delivery elapsed 3600s")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Candidate one" })).toHaveAttribute("src", "https://signed.example/candidate");
  expect(eq).toHaveBeenCalledWith("client_id", "client-1");
  expect(eq).toHaveBeenCalledWith("demand_id", "demand-1");
});

it("does not load candidates when there are no attempts", () => {
  render(<ProductionAttemptComparison clientId="client-1" demandId="demand-1" count={0} />);
  expect(screen.queryByRole("button", { name: "Compare attempts" })).not.toBeInTheDocument();
  expect(from).not.toHaveBeenCalled();
});
