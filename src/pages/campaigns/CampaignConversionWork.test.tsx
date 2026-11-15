import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
import { CampaignConversionWork } from "./CampaignConversionWork";

function rows(data: unknown[]) {
  const query = {
    select: () => query, eq: () => query, in: () => query,
    order: () => query, limit: () => query,
    maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error: null }),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };
  return query;
}

beforeEach(() => { from.mockReset(); rpc.mockReset(); });

it("shows the blocked page and its held dependent agent, then retries only the page", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_conversion_drafts_v7") return rows([
      { run_id: "run-1", page_work_item_id: "page-work",
        sales_work_item_id: "agent-work" },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "page-work", item_key: "campaign_page", state: "held",
        blocker: "Page producer failed" },
      { id: "agent-work", item_key: "campaign_sales_agent", state: "held",
        blocker: "Waiting for page" },
    ]);
    if (table === "workflow_steps") return rows([
      { id: "page-step", step_key: "conversion_page", status: "blocked",
        blocker: "Page producer failed" },
      { id: "agent-step", step_key: "conversion_sales_agent", status: "pending",
        blocker: null },
    ]);
    return rows([]);
  });
  rpc.mockResolvedValue({ data: { id: "page-step" }, error: null });
  render(<CampaignConversionWork clientId="client-1" campaignId="campaign-1"
    needsPage needsAgent />);
  expect(await screen.findByText("Campaign page")).toBeInTheDocument();
  expect(screen.getByText("Sales agent")).toBeInTheDocument();
  expect(screen.getByText("Waiting for page")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry this step" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("retry_campaign_conversion_step_v7",
    { p_step_id: "page-step" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Retry requested for campaign page");
});

it("keeps QA-ready drafts at human review", async () => {
  from.mockImplementation((table: string) => {
    if (table === "campaign_conversion_drafts_v7") return rows([
      { run_id: "run-1", page_work_item_id: "page-work", sales_work_item_id: null },
    ]);
    if (table === "delivery_work_effective_v6") return rows([
      { id: "page-work", item_key: "campaign_page", state: "ready_for_review",
        blocker: null },
    ]);
    if (table === "workflow_steps") return rows([
      { id: "page-step", step_key: "conversion_page", status: "completed", blocker: null },
    ]);
    return rows([]);
  });
  render(<CampaignConversionWork clientId="client-1" campaignId="campaign-1"
    needsPage needsAgent={false} />);
  expect(await screen.findByText(/Internal QA passed. Review the exact draft/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry this step" })).not.toBeInTheDocument();
});
