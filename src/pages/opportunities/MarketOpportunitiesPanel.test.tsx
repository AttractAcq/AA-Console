import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hand-off from an opportunity to a campaign.
 *
 * The whole argument for the opportunity layer is that a campaign should
 * exist because somebody would buy something, and the way that argument dies
 * is a person approving an opportunity and then writing a campaign brief
 * from memory on another screen. So what is pinned here is the gate: the
 * action appears exactly where the database would accept it, and never where
 * it would refuse — a button that always fails is worse than no button.
 *
 * And that planning is queued as its own act, because creating a campaign
 * that silently spends on a plan is a surprise.
 */

const {
  createCampaignFromOpportunity,
  fetchOpportunities,
  fetchReadiness,
  enqueueAgentJob,
} = vi.hoisted(() => ({
  createCampaignFromOpportunity: vi.fn(),
  fetchOpportunities: vi.fn(),
  fetchReadiness: vi.fn(),
  enqueueAgentJob: vi.fn(),
}));

vi.mock("../../lib/opportunities", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/opportunities");
  return {
    ...actual,
    createCampaignFromOpportunity,
    fetchOpportunities,
    fetchReadiness,
    fetchScoreFactors: async () => [],
  };
});
vi.mock("../../lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  enqueueAgentJob: (...a: unknown[]) => enqueueAgentJob(...(a as [])),
}));
vi.mock("../../lib/useAgentJobs", () => ({
  useAgentJobs: () => ({ inFlight: [], recentFailures: [] }),
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { MarketOpportunitiesPanel } from "./MarketOpportunitiesPanel";

const opportunity = (over: Record<string, unknown> = {}) => ({
  id: "opp-1",
  client_id: "client-1",
  name: "Garage-to-Gym Conversion",
  micro_market: "Homeowners with an unused garage",
  buying_situation: "They want the space usable this winter",
  status: "approved",
  confidence: "conversation",
  created_at: "2026-10-20T00:00:00Z",
  ...over,
});

const readiness = (over: Record<string, unknown> = {}) =>
  new Map([
    [
      "opp-1",
      {
        opportunity_id: "opp-1",
        score: 71,
        classification: "test",
        open_proof_gaps: 0,
        awareness_stages: 1,
        blocker: null,
        ...over,
      },
    ],
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  fetchOpportunities.mockResolvedValue([opportunity()]);
  fetchReadiness.mockResolvedValue(readiness());
  createCampaignFromOpportunity.mockResolvedValue({ id: "camp-1", name: "Garage-to-Gym Conversion" });
});

/** Open the row's action menu on the Activate view. */
async function openActions() {
  render(<MarketOpportunitiesPanel view="activate" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
}

describe("where the hand-off is offered", () => {
  it("offers it for an approved opportunity with nothing blocking", async () => {
    await openActions();
    expect(await screen.findByRole("menuitem", { name: "Create a campaign" })).toBeInTheDocument();
  });

  it("does not offer it while something is blocking", async () => {
    // The database refuses this, reading readiness at creation rather than
    // trusting the approval, so the screen must not offer it either.
    fetchReadiness.mockResolvedValue(
      readiness({ blocker: "1 claim has no proof on file. Capture it, or change the claim." }),
    );
    await openActions();
    expect(screen.queryByRole("menuitem", { name: "Create a campaign" })).not.toBeInTheDocument();
    expect(
      screen.getByText("1 claim has no proof on file. Capture it, or change the claim."),
    ).toBeInTheDocument();
  });

  it("does not offer it before anybody has approved the opportunity", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "validated" })]);
    await openActions();
    // Approve is the act that is available at this point, and it is a
    // different one.
    expect(await screen.findByRole("menuitem", { name: "Approve" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Create a campaign" })).not.toBeInTheDocument();
  });

  it("keeps offering it once campaigns are already running against it", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "active" })]);
    await openActions();
    expect(await screen.findByRole("menuitem", { name: "Create a campaign" })).toBeInTheDocument();
  });
});

describe("creating the campaign", () => {
  it("creates on the chosen route, then queues the planner separately", async () => {
    const user = userEvent.setup();
    await openActions();
    await user.click(await screen.findByRole("menuitem", { name: "Create a campaign" }));

    expect(
      await screen.findByText(/cannot be changed afterwards/),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Route/), "paid");
    await user.selectOptions(screen.getByLabelText(/Paid platform/), "meta");
    await user.click(screen.getByRole("button", { name: "Create and plan" }));

    await waitFor(() =>
      expect(createCampaignFromOpportunity).toHaveBeenCalledWith({
        opportunityId: "opp-1",
        acquisitionMode: "paid",
        paidPlatform: "meta",
        name: "",
      }),
    );
    // Queued, not implied: a creation that silently spends on a plan is a
    // surprise, so this is the same separate act the Campaign Factory form
    // performs.
    expect(enqueueAgentJob).toHaveBeenCalledWith({
      agentKey: "campaign_plan",
      clientId: "client-1",
      inputTable: "client_campaigns",
      inputId: "camp-1",
    });
    expect(await screen.findByText(/The planner is writing it now/)).toBeInTheDocument();
  });

  it("asks for a platform before letting a paid campaign through", async () => {
    const user = userEvent.setup();
    await openActions();
    await user.click(await screen.findByRole("menuitem", { name: "Create a campaign" }));
    await user.selectOptions(screen.getByLabelText(/Route/), "paid");
    await user.click(screen.getByRole("button", { name: "Create and plan" }));

    expect(await screen.findByText(/Choose Meta Ads or Google Ads/)).toBeInTheDocument();
    expect(createCampaignFromOpportunity).not.toHaveBeenCalled();
  });

  it("shows the database's refusal rather than a generic failure", async () => {
    const user = userEvent.setup();
    createCampaignFromOpportunity.mockRejectedValue(
      new Error("Scored as reject at 31. Score it again or reject it properly."),
    );
    await openActions();
    await user.click(await screen.findByRole("menuitem", { name: "Create a campaign" }));
    await user.selectOptions(screen.getByLabelText(/Route/), "organic");
    await user.click(screen.getByRole("button", { name: "Create and plan" }));

    expect(await screen.findByText(/Scored as reject at 31/)).toBeInTheDocument();
    expect(enqueueAgentJob).not.toHaveBeenCalled();
  });
});
