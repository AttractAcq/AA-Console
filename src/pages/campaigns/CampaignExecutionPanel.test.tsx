import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, useAgentJobs, callRuntime } = vi.hoisted(() => ({
  callRuntime: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  useAgentJobs: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from,
    rpc,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("react-router-dom", () => ({
  useParams,
  // Link renders as an anchor so tests can still find navigation by role.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));
// Only the hook is faked; agentLabel and elapsedLabel are real, because the
// activity bar renders them.
vi.mock("../../lib/useAgentJobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/useAgentJobs")>()),
  useAgentJobs,
}));

import { CampaignExecutionPanel, type Requirement } from "./CampaignExecutionPanel";

const planned = (over: Record<string, unknown> = {}) => ({
  id: "camp-1",
  name: "Winter full-arch push",
  brief: "Fill the January consult diary",
  status: "planning",
  objective: "Book 40 consultations in January",
  audience: "Over-55s with a failing plate",
  offer_summary: "Free consultation",
  core_message: "Chewing is not a cosmetic problem",
  channels: ["instagram", "facebook"],
  budget: 20000,
  starts_on: "2027-01-05",
  ends_on: "2027-01-31",
  kpi_metric: "consultations booked",
  kpi_target: 40,
  content_count: 2,
  needs_landing_page: true,
  needs_sales_agent: true,
  built_at: "2026-09-09T10:00:00Z",
  content_ideas_generated_at: "2026-09-09T10:02:00Z",
  launched_at: null,
  created_at: "2026-09-09T09:00:00Z",
  ...over,
});

const req = (name: string, met: boolean, detail: string): Requirement => ({
  requirement: name,
  required: 1,
  have: met ? 1 : 0,
  met,
  detail,
});

const READY: Requirement[] = [
  req("Plan", true, "Written by the planner."),
  req("Content", true, "2 of 2 pieces ready to distribute."),
  req("Landing page", true, "Built."),
  req("Sales agent", true, "Built and live."),
];

const NOT_READY: Requirement[] = [
  req("Plan", true, "Written by the planner."),
  req("Content", false, "0 of 2 pieces ready to distribute."),
  req("Landing page", false, "No page with any HTML in it is attached to this campaign."),
  req("Sales agent", true, "Built and live."),
];

function show(campaigns: unknown[] = [planned()], reqs: Requirement[] = NOT_READY) {
  from.mockImplementation(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: [] }),
      then: (r: (v: { data: unknown }) => unknown) => Promise.resolve({ data: campaigns }).then(r),
    };
    return chain;
  });
  rpc.mockImplementation((name: string) => {
    if (name === "campaign_readiness") return Promise.resolve({ data: reqs, error: null });
    return Promise.resolve({ data: [], error: null });
  });
  return render(<CampaignExecutionPanel />);
}

/** Cards arrive collapsed, so anything inside one has to be opened first. */
async function open(name = "Winter full-arch push") {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(name, "i") }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  useAgentJobs.mockReturnValue({ inFlight: [], recentFailures: [] });
});

describe("the plan", () => {
  it("shows what the planner decided, not the raw brief", async () => {
    show();
    expect(await screen.findByText("Winter full-arch push")).toBeInTheDocument();
    await open();
    expect(screen.getByText("Book 40 consultations in January")).toBeInTheDocument();
    expect(screen.getByText("instagram, facebook")).toBeInTheDocument();
    expect(screen.getByText(/consultations booked · target 40/)).toBeInTheDocument();
  });

  it("says a campaign is still being planned rather than showing empty fields", async () => {
    show([planned({ built_at: null, objective: null })]);
    // Visible collapsed, because triaging a list must not need fifteen clicks.
    expect(await screen.findByText(/waiting for the planner/i)).toBeInTheDocument();
  });
});

describe("collapsing", () => {
  it("opens collapsed, so fifteen campaigns are a list and not a wall", async () => {
    show();
    await screen.findByText("Winter full-arch push");
    // The objective stays visible — it is the card's one-line summary. What
    // goes away is the detail: channels, requirements, and every action.
    expect(screen.queryByText("instagram, facebook")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch" })).not.toBeInTheDocument();
    expect(screen.queryByText("Before this can launch")).not.toBeInTheDocument();
  });

  it("still says where a campaign stands while collapsed", async () => {
    // Otherwise triaging a list means opening every card in it.
    show();
    expect(await screen.findByText(/Planned\. · 2 things still missing/)).toBeInTheDocument();
  });

  it("opens and closes on the heading", async () => {
    show();
    const toggle = await screen.findByRole("button", { name: /Winter full-arch push/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("instagram, facebook")).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("instagram, facebook")).not.toBeInTheDocument();
  });

  it("opens one card without opening the rest", async () => {
    show([planned(), planned({ id: "camp-2", name: "Spring whitening" })]);
    await userEvent.click(await screen.findByRole("button", { name: /Winter full-arch push/i }));
    expect(screen.getByRole("button", { name: /Spring whitening/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the campaign name a heading, so the list is still navigable", async () => {
    show();
    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(1);
  });
});

describe("readiness", () => {
  it("lists every requirement with the reason it is or is not met", async () => {
    show();
    await open();
    expect(
      await screen.findByText("No page with any HTML in it is attached to this campaign."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 of 2 pieces ready to distribute.")).toBeInTheDocument();
  });

  it("will not let an unready campaign be launched", async () => {
    show();
    await open();
    const launch = await screen.findByRole("button", { name: "Launch" });
    expect(launch).toBeDisabled();
    expect(screen.getByText("2 things still missing")).toBeInTheDocument();
  });

  it("enables launch only when every requirement is met", async () => {
    show([planned()], READY);
    await open();
    expect(await screen.findByRole("button", { name: "Launch" })).toBeEnabled();
    expect(screen.queryByText(/still missing/)).not.toBeInTheDocument();
  });

  it("does not treat an unchecked campaign as ready", async () => {
    // No requirements returned means nothing has been verified, which is not
    // the same as everything passing.
    show([planned()], []);
    await open();
    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
  });
});

// "Build what it needs" could not say what it was about to do, and built a
// sales agent nobody had asked for as a side effect of wanting a page. Each
// build is now named, and asked for separately.
describe("building what the campaign needs", () => {
  const buildReturns = (created: string) => {
    rpc.mockImplementation((name: string) => {
      if (name === "campaign_readiness") return Promise.resolve({ data: NOT_READY, error: null });
      return Promise.resolve({ data: [{ created, artifact_id: "a1" }], error: null });
    });
  };

  it("builds only the landing page when that is what was asked for", async () => {
    show();
    await open();
    buildReturns("landing_page");
    await userEvent.click(await screen.findByRole("button", { name: "Build landing page" }));
    expect(rpc).toHaveBeenCalledWith("provision_campaign_artifact", {
      p_campaign_id: "camp-1",
      p_kind: "landing_page",
    });
    expect(await screen.findByText(/building the landing page/i)).toBeInTheDocument();
  });

  it("builds only the sales agent when that is what was asked for", async () => {
    show();
    await open();
    buildReturns("sales_agent");
    await userEvent.click(await screen.findByRole("button", { name: "Build sales agent" }));
    expect(rpc).toHaveBeenCalledWith("provision_campaign_artifact", {
      p_campaign_id: "camp-1",
      p_kind: "sales_agent",
    });
    expect(await screen.findByText(/building the sales agent/i)).toBeInTheDocument();
  });

  it("offers a sales agent even when the plan did not ask for one", async () => {
    // Deciding later that a campaign should have an agent is ordinary; the
    // alternative is re-planning, which rewrites numbers already acted on.
    show([planned({ needs_sales_agent: false, needs_landing_page: false })]);
    await open();
    expect(await screen.findByRole("button", { name: "Build sales agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Build landing page" })).toBeEnabled();
  });

  it("offers neither until the planner has written the campaign", async () => {
    show([planned({ built_at: null, objective: null })]);
    await screen.findByText(/waiting for the planner/i);
    await open("Winter full-arch push");
    expect(screen.queryByRole("button", { name: "Build landing page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build sales agent" })).not.toBeInTheDocument();
  });

  it("says plainly when there was nothing left to create", async () => {
    show();
    await open();
    buildReturns("already_exists");
    // Pressing it twice is the common case — an agent takes minutes and the
    // page looks unchanged while it runs. Silence would read as failure.
    await userEvent.click(await screen.findByRole("button", { name: "Build landing page" }));
    expect(await screen.findByText(/already has a landing page/i)).toBeInTheDocument();
  });

  it("shows the database's refusal verbatim, because it names what is missing", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "campaign_readiness") return Promise.resolve({ data: READY, error: null });
      return Promise.resolve({
        data: null,
        error: { message: "Not ready to launch: 0 of 2 pieces ready to distribute." },
      });
    });
    from.mockImplementation(() => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: [] }),
        then: (r: (v: { data: unknown }) => unknown) =>
          Promise.resolve({ data: [planned()] }).then(r),
      };
      return chain;
    });
    render(<CampaignExecutionPanel />);

    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Launch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not ready to launch: 0 of 2 pieces ready to distribute.",
    );
  });
});

describe("campaign visibility", () => {
  it("renders all 15 planning campaigns for Attract Acquisition", async () => {
    useParams.mockReturnValue({ clientId: "e4b4b001-81f6-4997-8429-ff21f4ee1fbe" });
    show(Array.from({ length: 15 }, (_, i) => planned({ id: `camp-${i}`, name: `Planning ${i}` })));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(15);
    expect(from).toHaveBeenCalledWith("client_campaigns");
  });
  it("distinguishes a successful empty query", async () => {
    show([]);
    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
  });
  it.each(["RLS query denied", "column client_campaigns.content_ideas_generated_at does not exist"])("surfaces query errors rather than an empty state: %s", async (message) => {
    const initial = show();
    initial.unmount();
    from.mockImplementation(() => {
      const chain = { select: () => chain, eq: () => chain, order: () => chain,
        limit: () => Promise.resolve({ data: [] }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message } }).then(r) };
      return chain;
    });
    // A fresh mount starts the failing request.
    const { unmount } = render(<CampaignExecutionPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(`Failed to load campaigns: ${message}`);
    expect(screen.queryByText("No campaigns yet")).not.toBeInTheDocument();
    unmount();
  });
  it("shows readiness failure and disables launch", async () => {
    // show() installs its own rpc mock, so the failure has to be set after it.
    show();
    rpc.mockResolvedValue({ data: null, error: { message: "Not permitted" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load readiness");
    await open();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });
  it("reports a missing route client instead of pretending there are no campaigns", async () => {
    useParams.mockReturnValue({});
    show([]);
    expect(await screen.findByRole("alert")).toHaveTextContent("No client selected");
    expect(screen.queryByText("No campaigns yet")).not.toBeInTheDocument();
  });
  it("launches a ready campaign through the existing RPC", async () => {
    show([planned()], READY);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Launch" }));
    expect(rpc).toHaveBeenCalledWith("launch_campaign", { p_campaign_id: "camp-1" });
    expect(await screen.findByText(/is live\./)).toBeInTheDocument();
  });
});


// A campaign can exist without ever having been planned: seeded, created
// through the gateway, or left behind by a planner run that failed. New
// Campaign queues the planner at creation and nothing else ever did, so those
// campaigns were unrecoverable — the panel showed an empty card and offered no
// way to ask for the plan it was waiting for.
describe("starting the planner on a campaign that has none", () => {
  const unplanned = () => planned({ built_at: null, objective: null });

  it("offers to run the planner", async () => {
    show([unplanned()]);
    await open();
    expect(await screen.findByRole("button", { name: "Run the planner" })).toBeEnabled();
  });

  it("queues the planner against that campaign", async () => {
    show([unplanned()]);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Run the planner" }));
    expect(rpc).toHaveBeenCalledWith("enqueue_agent_job", {
      p_agent_key: "campaign_plan",
      p_client_id: "client-1",
      p_input_table: "client_campaigns",
      p_input_id: "camp-1",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/planner is writing/i);
  });

  it("shows the database's refusal, because it names the missing upstream work", async () => {
    show([unplanned()]);
    await open();
    const button = await screen.findByRole("button", { name: "Run the planner" });
    // Set after render: show() installs its own rpc implementation.
    rpc.mockImplementation((name: string) => {
      if (name === "campaign_readiness") return Promise.resolve({ data: NOT_READY, error: null });
      return Promise.resolve({
        data: null,
        error: { message: "Agent campaign_plan is missing required upstream intelligence" },
      });
    });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/missing required upstream/i);
  });

  it("does not offer to re-plan a campaign that already has a plan", async () => {
    // Re-planning would rewrite the numbers the readiness check and anything
    // already provisioned were measured against.
    show([planned()]);
    await screen.findByText("Winter full-arch push");
    expect(screen.queryByRole("button", { name: "Run the planner" })).not.toBeInTheDocument();
  });
});

describe("while the planner is running", () => {
  const running = (inputId: string | null) => ({
    id: "job-1",
    agent_key: "campaign_plan",
    input_id: inputId,
    status: "running",
    attempts: 1,
    error: null,
    created_at: "2026-09-14T10:00:00Z",
    started_at: "2026-09-14T10:00:01Z",
    completed_at: null,
  });

  it("will not queue a second paid run of the same planner", async () => {
    useAgentJobs.mockReturnValue({ inFlight: [running("camp-1")], recentFailures: [] });
    show([planned({ built_at: null, objective: null })]);
    await open();
    const button = await screen.findByRole("button", { name: "Planning…" });
    expect(button).toBeDisabled();
  });

  it("says the planner is working rather than that nobody is", async () => {
    useAgentJobs.mockReturnValue({ inFlight: [running("camp-1")], recentFailures: [] });
    show([planned({ built_at: null, objective: null })]);
    await open("Winter full-arch push");
    expect(await screen.findByText(/planner is writing this now/i)).toBeInTheDocument();
  });

  it("only disables the campaign actually being planned", async () => {
    // A job in flight for a different campaign must not lock this one.
    useAgentJobs.mockReturnValue({ inFlight: [running("camp-OTHER")], recentFailures: [] });
    show([planned({ built_at: null, objective: null })]);
    await open();
    expect(await screen.findByRole("button", { name: "Run the planner" })).toBeEnabled();
  });

  it("ignores another agent's job that happens to be in flight", async () => {
    useAgentJobs.mockReturnValue({
      inFlight: [{ ...running("camp-1"), agent_key: "page_audit" }],
      recentFailures: [],
    });
    show([planned({ built_at: null, objective: null })]);
    await open();
    expect(await screen.findByRole("button", { name: "Run the planner" })).toBeEnabled();
  });
});

// New Campaign asks for a name and a one-line ask. The answer to "which
// campaign is worth running" is sitting in the client's own records — the
// offer strategy, the ICP, the money model, the competitor work — and nobody
// reads all of it before typing a campaign name.
describe("proposing a campaign", () => {
  const PROPOSAL = {
    name: "January full-arch diary fill",
    brief:
      "Fill the January consultation diary with full-arch patients, using the written plan assessment the offer strategy says nobody is using.",
  };

  async function openProposer() {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /New Campaign/i }));
    await userEvent.click(screen.getByRole("button", { name: "Generate with AI" }));
  }

  it("asks the runtime for a proposal and fills the form", async () => {
    callRuntime.mockResolvedValue({ draft: PROPOSAL });
    await openProposer();

    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/campaigns/draft", {
        clientId: "client-1",
        notes: "",
      }),
    );
    expect(await screen.findByDisplayValue(PROPOSAL.name)).toBeInTheDocument();
    expect(screen.getByDisplayValue(PROPOSAL.brief)).toBeInTheDocument();
  });

  it("generates from a blank box, because the strategy is already on file", async () => {
    // Unlike a hiring brief, where the operator knows things written down
    // nowhere, a campaign proposal has the records to work from.
    callRuntime.mockResolvedValue({ draft: PROPOSAL });
    await openProposer();
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("sends the steer when there is one", async () => {
    callRuntime.mockResolvedValue({ draft: PROPOSAL });
    await openProposer();
    await userEvent.type(screen.getByLabelText(/Anything to steer it/i), "Push the January diary.");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/campaigns/draft", {
        clientId: "client-1",
        notes: "Push the January diary.",
      }),
    );
  });

  it("shows the runtime's refusal and stays open to try again", async () => {
    callRuntime.mockRejectedValue(new Error("The ask names a budget."));
    await openProposer();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/names a budget/i);
    expect(screen.getByLabelText(/Anything to steer it/i)).toBeInTheDocument();
  });
});
