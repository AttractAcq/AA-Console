import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));

import { CampaignSweepWork } from "./CampaignSweepWork";

function rows(data: unknown[]) {
  const query = {
    select: () => query, eq: () => query, in: () => query, order: () => query,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return query;
}

beforeEach(() => {
  from.mockReset(); rpc.mockReset();
});

it("shows current route work and retries only its blocked step", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_route_packages_v6") return rows([
      { id: "organic-v2", route: "organic", version: 2 },
      { id: "organic-v1", route: "organic", version: 1 },
      { id: "paid-v1", route: "paid", version: 1 },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "work-1", route_package_id: "organic-v2", item_key: "content_piece1",
        state: "held", blocker: "Source failed", qa_state: "not_run",
        expected_output: { platform: "instagram", media_type: "video", content_format: "reel" } },
      { id: "work-2", route_package_id: "paid-v1", item_key: "content_piece2",
        state: "prepared", blocker: null, qa_state: "not_run",
        expected_output: { platform: "facebook", media_type: "image", content_format: "single" } },
    ]);
    if (table === "production_demand_counts_v8") return rows([
      { demand_id: "work-1", attempts: 2, produced: 1, rejected: 1, revised: 1,
        workflow_accepted: 0, human_approved: 0 },
    ]);
    if (table === "campaign_sweep_work_bindings_v7") return rows([
      { work_item_id: "work-1", run_id: "run-1", piece_key: "piece1" },
      { work_item_id: "work-2", run_id: "run-1", piece_key: "piece2" },
    ]);
    if (table === "workflow_steps") return rows([
      { id: "step-1", run_id: "run-1", step_key: "piece1_motion",
        status: "blocked", blocker: "Motion failed" },
      { id: "step-2", run_id: "run-1", step_key: "piece2_create",
        status: "completed", blocker: null },
    ]);
    return rows([]);
  });
  rpc.mockResolvedValue({ data: { id: "step-1" }, error: null });
  render(<CampaignSweepWork clientId="client-1" campaignId="campaign-1" />);
  expect(await screen.findByText(/content piece1 · organic v2/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Request ID:/)).toHaveLength(2);
  expect(screen.getByText(/content piece2 · paid v1/i)).toBeInTheDocument();
  expect(screen.getByText(/Motion failed/)).toBeInTheDocument();
  expect(screen.getByText(/1 requested · 1 produced · 1 failed or rejected attempts/)).toBeInTheDocument();
  expect(screen.getByText(/1 revised · 0 passed workflow QA/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry this step" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("retry_campaign_sweep_step_v7",
    { p_step_id: "step-1" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Retry requested for piece1 motion");
});

it("keeps paid and organic producer work in their selected campaign tabs", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_route_packages_v6") return rows([
      { id: "organic-v1", route: "organic", version: 1 },
      { id: "paid-v1", route: "paid", version: 1 },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "organic-work", route_package_id: "organic-v1", item_key: "content_piece1",
        state: "held", blocker: "Organic render failed", qa_state: "not_run", expected_output: {} },
      { id: "paid-work", route_package_id: "paid-v1", item_key: "content_piece2",
        state: "held", blocker: "Paid render failed", qa_state: "not_run", expected_output: {} },
    ]);
    return rows([]);
  });
  render(<CampaignSweepWork clientId="client-1" campaignId="campaign-1" route="paid" />);
  expect(await screen.findByText(/content piece2 · paid v1/i)).toBeInTheDocument();
  expect(screen.getByText("Paid render failed")).toBeInTheDocument();
  expect(screen.queryByText(/content piece1 · organic v1/i)).not.toBeInTheDocument();
  expect(screen.queryByText("Organic render failed")).not.toBeInTheDocument();
});

it("labels internal QA as review pending", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_route_packages_v6") return rows([
      { id: "organic-v1", route: "organic", version: 1 },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "work-1", route_package_id: "organic-v1", item_key: "content_piece1",
        state: "ready_for_review", blocker: null, qa_state: "passed",
        expected_output: { platform: "instagram", media_type: "image", content_format: "single" } },
    ]);
    if (table === "campaign_sweep_work_bindings_v7") return rows([
      { work_item_id: "work-1", run_id: "run-1", piece_key: "piece1" },
    ]);
    if (table === "workflow_steps") return rows([
      { id: "step-1", run_id: "run-1", step_key: "piece1_create",
        status: "completed", blocker: null },
    ]);
    return rows([]);
  });
  render(<CampaignSweepWork clientId="client-1" campaignId="campaign-1" />);
  expect(await screen.findByText(/Internal QA passed. Review the exact asset/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry this step" })).not.toBeInTheDocument();
});

it("shows an invalidated output as held even when its stored state was reviewable", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_route_packages_v6") return rows([
      { id: "organic-v1", route: "organic", version: 1 },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "work-1", route_package_id: "organic-v1", item_key: "content_piece1",
        state: "ready_for_review", effective_state: "held", blocker: null,
        effective_blocker: "An output version changed; create a new work version.",
        qa_state: "passed", expected_output: { platform: "instagram" } },
    ]);
    if (table === "campaign_sweep_work_bindings_v7") return rows([
      { work_item_id: "work-1", run_id: "run-1", piece_key: "piece1" },
    ]);
    if (table === "workflow_steps") return rows([
      { id: "step-1", run_id: "run-1", step_key: "piece1_create",
        status: "completed", blocker: null },
    ]);
    return rows([]);
  });
  render(<CampaignSweepWork clientId="client-1" campaignId="campaign-1" />);
  expect(await screen.findByText(/An output version changed/)).toBeInTheDocument();
  expect(screen.queryByText(/Internal QA passed. Review the exact asset/)).not.toBeInTheDocument();
});
