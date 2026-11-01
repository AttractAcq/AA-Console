import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  fetchStageTemplates,
  setStageTemplate,
  rpc,
} = vi.hoisted(() => ({
  createCampaignFromOpportunity: vi.fn(),
  fetchOpportunities: vi.fn(),
  fetchReadiness: vi.fn(),
  enqueueAgentJob: vi.fn(),
  fetchStageTemplates: vi.fn(),
  setStageTemplate: vi.fn(),
  rpc: vi.fn(),
}));

/** The query string the panel reads. Defaults to none, so existing tests are unaffected. */
const search = vi.hoisted(() => ({ value: "" }));

vi.mock("../../lib/opportunities", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/opportunities");
  return {
    ...actual,
    createCampaignFromOpportunity,
    fetchOpportunities,
    fetchReadiness,
    fetchScoreFactors: async () => [],
    fetchStageTemplates,
    setStageTemplate,
  };
});
vi.mock("../../lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: (...a: unknown[]) => rpc(...(a as [])) },
  enqueueAgentJob: (...a: unknown[]) => enqueueAgentJob(...(a as [])),
}));
vi.mock("../../lib/useAgentJobs", () => ({
  useAgentJobs: () => ({ inFlight: [], recentFailures: [] }),
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  useSearchParams: () => [new URLSearchParams(search.value), vi.fn()],
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


/**
 * The template planner — G06.
 *
 * The decision it exists for is which of the sixteen moves a given awareness
 * stage, and the thing worth pinning is that it stays a recommendation: the
 * trade-off is shown, a reason is required, and nothing is chosen for you.
 */
const candidate = (over: Record<string, unknown> = {}) => ({
  stage_id: "stage-1",
  opportunity_id: "opp-1",
  awareness_level: "problem_aware",
  mindset: "Feels the damp every winter",
  audience_state: "S1",
  audience_state_override: null,
  state_overridden: false,
  state_note: "Feels the problem and has seen the client in passing.",
  recommended_template: null,
  candidate_template: "R1",
  candidate_name: "Retarget to next step",
  fn: "spend",
  entry_state: "S1",
  exit_state: "S3",
  destination: "page",
  kpi: "Cost per booked survey",
  purpose: "The highest return in the account.",
  guardrail: "Retargeting an empty pool spends money on nobody.",
  prerequisite: "P1 or P4 running 14 days or more.",
  chosen: false,
  fit: "Moves S1 to S3 via page. Needs: P1 or P4 running 14 days or more.",
  ...over,
});

describe("the template planner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchOpportunities.mockResolvedValue([opportunity()]);
    fetchReadiness.mockResolvedValue(readiness());
    fetchStageTemplates.mockResolvedValue([candidate()]);
    setStageTemplate.mockResolvedValue(undefined);
    // Strategize only renders for a selected opportunity.
    search.value = "opportunity=opp-1";
  });

  afterEach(() => {
    search.value = "";
  });

  it("shows the trade-off beside each candidate, not just its name", async () => {
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    await waitFor(() => expect(fetchStageTemplates).toHaveBeenCalled());

    expect(await screen.findByText("R1")).toBeTruthy();
    // The prerequisite and the guardrail are the half a strategist weighs.
    expect(screen.getByText("P1 or P4 running 14 days or more.")).toBeTruthy();
    expect(
      screen.getByText("Retargeting an empty pool spends money on nobody."),
    ).toBeTruthy();
  });

  it("will not record a choice without a reason", async () => {
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    await waitFor(() => expect(fetchStageTemplates).toHaveBeenCalled());

    const select = await screen.findByLabelText("Template for problem_aware");
    await userEvent.selectOptions(select, "R1");

    const record = screen.getByRole("button", { name: "Record choice" });
    expect(record.hasAttribute("disabled")).toBe(true);

    await userEvent.type(
      screen.getByLabelText("Why for problem_aware"),
      "The pool from P1 is warm enough to harvest",
    );
    expect(record.hasAttribute("disabled")).toBe(false);
  });

  it("records the stage, the template and the reason", async () => {
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    await waitFor(() => expect(fetchStageTemplates).toHaveBeenCalled());

    await userEvent.selectOptions(
      await screen.findByLabelText("Template for problem_aware"), "R1",
    );
    await userEvent.type(screen.getByLabelText("Why for problem_aware"), "Pool is warm");
    await userEvent.click(screen.getByRole("button", { name: "Record choice" }));

    await waitFor(() =>
      expect(setStageTemplate).toHaveBeenCalledWith("stage-1", "R1", "Pool is warm"),
    );
  });

  it("says what a chosen template is, rather than leaving it to the dropdown", async () => {
    fetchStageTemplates.mockResolvedValue([
      candidate({ chosen: true, recommended_template: "R1" }),
    ]);
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    expect(await screen.findByText(/chosen: R1 — Retarget to next step/)).toBeTruthy();
  });

  it("marks an overridden audience state, so a local rule is not mistaken for the map", async () => {
    fetchStageTemplates.mockResolvedValue([
      candidate({ state_overridden: true, audience_state_override: "S1", state_note: null }),
    ]);
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    expect(await screen.findByText(/S1 \(overridden\)/)).toBeTruthy();
  });

  it("asks for a stage before offering templates", async () => {
    fetchStageTemplates.mockResolvedValue([]);
    render(createElement(MarketOpportunitiesPanel, { view: "strategize" }));
    expect(
      await screen.findByText(/Save an awareness stage above and its candidates appear here/),
    ).toBeTruthy();
  });
});

/** Open the row's action menu on the Discover table. */
async function openDiscoverActions() {
  render(<MarketOpportunitiesPanel view="discover" />);
  await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
}

describe("the Discover table carries the whole progression", () => {
  /**
   * The notes: "Activate can rather be in the table in the Discover - the
   * actions buttons, so it is easier to navigate to see what market
   * opportunities are active."
   *
   * Discover used to offer only validate, work on it and reject, so moving an
   * opportunity forward meant leaving the table for a separate view reached
   * through a dropdown. Both views now build their actions from one list, so
   * the status gating cannot differ between them.
   */
  it("offers the campaign hand-off from the table, not only from Activate", async () => {
    await openDiscoverActions();
    expect(await screen.findByRole("menuitem", { name: "Create a campaign" })).toBeInTheDocument();
  });

  it("offers Approve from the table for a validated opportunity", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "validated" })]);
    await openDiscoverActions();
    expect(await screen.findByRole("menuitem", { name: "Approve" })).toBeInTheDocument();
  });

  it("offers the next step for each stage, and only that step", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "active" })]);
    await openDiscoverActions();
    expect(await screen.findByRole("menuitem", { name: "Mark learning" })).toBeInTheDocument();
    // Not two stages at once: scaling comes after learning, not beside it.
    expect(screen.queryByRole("menuitem", { name: "Scale it" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Mark active" })).not.toBeInTheDocument();
  });

  it("still withholds the hand-off while something is blocking", async () => {
    // The gating has to survive being shared: the database refuses this and a
    // button that always fails is worse than no button.
    fetchReadiness.mockResolvedValue(
      readiness({ blocker: "1 claim has no proof on file. Capture it, or change the claim." }),
    );
    await openDiscoverActions();
    expect(screen.queryByRole("menuitem", { name: "Create a campaign" })).not.toBeInTheDocument();
  });

  it("does not offer Pause before anything is approved", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "discovered" })]);
    await openDiscoverActions();
    expect(await screen.findByRole("menuitem", { name: "Mark validated" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("shows the status as its own column so an active one is visible at a glance", async () => {
    fetchOpportunities.mockResolvedValue([opportunity({ status: "active" })]);
    render(<MarketOpportunitiesPanel view="discover" />);
    expect(await screen.findByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });
});

describe("saying how many opportunities to look for", () => {
  /**
   * The notes: "there is no way to instruct it how many opportunities to
   * assess; this full control is important".
   *
   * It goes through request_opportunity_discovery_v6 rather than the generic
   * enqueuer, because that one takes no parameters at all and widening it
   * would let a browser caller shape the input of every agent in the system.
   */
  beforeEach(() => {
    rpc.mockResolvedValue({ data: "job-1", error: null });
  });

  it("asks for the number the operator typed", async () => {
    const user = userEvent.setup();
    render(<MarketOpportunitiesPanel view="discover" />);
    await user.click(await screen.findByRole("button", { name: "Find opportunities" }));

    const dialog = await screen.findByRole("dialog");
    const count = within(dialog).getByLabelText(/How many to look for/);
    await user.clear(count);
    await user.type(count, "6");
    await user.click(within(dialog).getByRole("button", { name: "Find opportunities" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("request_opportunity_discovery_v6", {
        p_client_id: "client-1",
        p_count: 6,
      }),
    );
  });

  it("defaults to four rather than leaving it blank", async () => {
    const user = userEvent.setup();
    render(<MarketOpportunitiesPanel view="discover" />);
    await user.click(await screen.findByRole("button", { name: "Find opportunities" }));
    expect(await screen.findByLabelText(/How many to look for/)).toHaveValue(4);
  });

  it("does not use the generic enqueuer, which cannot carry the count", async () => {
    const user = userEvent.setup();
    render(<MarketOpportunitiesPanel view="discover" />);
    await user.click(await screen.findByRole("button", { name: "Find opportunities" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Find opportunities" }));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(enqueueAgentJob).not.toHaveBeenCalled();
  });

  it("surfaces the database's refusal rather than reporting success", async () => {
    // 304 refuses anything outside 2..8 before a job is queued, and the
    // message is the useful part.
    rpc.mockResolvedValue({
      data: null,
      error: { message: "Ask for between 2 and 8 opportunities in one pass." },
    });
    const user = userEvent.setup();
    render(<MarketOpportunitiesPanel view="discover" />);
    await user.click(await screen.findByRole("button", { name: "Find opportunities" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Find opportunities" }));
    expect(
      await screen.findByText(/Ask for between 2 and 8 opportunities in one pass/),
    ).toBeInTheDocument();
  });
});
