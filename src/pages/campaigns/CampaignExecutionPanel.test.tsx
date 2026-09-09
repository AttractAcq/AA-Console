import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from,
    rpc,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("react-router-dom", () => ({ useParams }));

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
  req("Content", true, "2 of 2 pieces written or approved."),
  req("Landing page", true, "Built."),
  req("Sales agent", true, "Built and live."),
];

const NOT_READY: Requirement[] = [
  req("Plan", true, "Written by the planner."),
  req("Content", false, "0 of 2 pieces written or approved."),
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

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("the plan", () => {
  it("shows what the planner decided, not the raw brief", async () => {
    show();
    expect(await screen.findByText("Winter full-arch push")).toBeInTheDocument();
    expect(screen.getByText("Book 40 consultations in January")).toBeInTheDocument();
    expect(screen.getByText("instagram, facebook")).toBeInTheDocument();
    expect(screen.getByText(/consultations booked · target 40/)).toBeInTheDocument();
  });

  it("says a campaign is still being planned rather than showing empty fields", async () => {
    show([planned({ built_at: null, objective: null })]);
    expect(await screen.findByText(/waiting for the planner/i)).toBeInTheDocument();
  });
});

describe("readiness", () => {
  it("lists every requirement with the reason it is or is not met", async () => {
    show();
    expect(
      await screen.findByText("No page with any HTML in it is attached to this campaign."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 of 2 pieces written or approved.")).toBeInTheDocument();
  });

  it("will not let an unready campaign be launched", async () => {
    show();
    const launch = await screen.findByRole("button", { name: "Launch" });
    expect(launch).toBeDisabled();
    expect(screen.getByText("2 things still missing")).toBeInTheDocument();
  });

  it("enables launch only when every requirement is met", async () => {
    show([planned()], READY);
    expect(await screen.findByRole("button", { name: "Launch" })).toBeEnabled();
    expect(screen.queryByText(/still missing/)).not.toBeInTheDocument();
  });

  it("does not treat an unchecked campaign as ready", async () => {
    // No requirements returned means nothing has been verified, which is not
    // the same as everything passing.
    show([planned()], []);
    expect(await screen.findByRole("button", { name: "Launch" })).toBeDisabled();
  });
});

describe("building what the campaign needs", () => {
  it("calls provision and reports how many builds were queued", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "campaign_readiness") return Promise.resolve({ data: NOT_READY, error: null });
      return Promise.resolve({
        data: [
          { created: "landing_page", artifact_id: "p1" },
          { created: "sales_agent", artifact_id: "s1" },
        ],
        error: null,
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

    await userEvent.click(await screen.findByRole("button", { name: /build what it needs/i }));
    expect(rpc).toHaveBeenCalledWith("provision_campaign", { p_campaign_id: "camp-1" });
    expect(await screen.findByText(/queued 2 builds/i)).toBeInTheDocument();
  });

  it("says plainly when there was nothing left to create", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /build what it needs/i }));
    // Pressing it twice is the common case, and silence would read as failure.
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it("shows the database's refusal verbatim, because it names what is missing", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "campaign_readiness") return Promise.resolve({ data: READY, error: null });
      return Promise.resolve({
        data: null,
        error: { message: "Not ready to launch: 0 of 2 pieces written or approved." },
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

    await userEvent.click(await screen.findByRole("button", { name: "Launch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not ready to launch: 0 of 2 pieces written or approved.",
    );
  });
});
