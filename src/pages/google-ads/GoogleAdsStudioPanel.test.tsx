import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The claim this page must never make.
 *
 * There is no Google Ads adapter, so nothing here may read as able to build
 * or spend. And a sheet must not read as a keyword plan: seeds are labelled,
 * what the sheet does not know is shown beside what it does, and a campaign
 * with nothing to seed from says so rather than showing an empty list that
 * looks like "no keywords needed".
 */

const { from, enqueueAgentJob } = vi.hoisted(() => ({ from: vi.fn(), enqueueAgentJob: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from }, enqueueAgentJob }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { GoogleAdsStudioPanel } from "./GoogleAdsStudioPanel";

const row = (over: Record<string, unknown> = {}) => ({
  campaign_id: "camp-1", client_id: "client-1", name: "Winter garage push",
  sheet_id: null, sheet_version: null, missing: null, sheet_created_at: null,
  pillars: 2, daily_budget: 40, target_countries: ["Portsmouth"],
  conversion_event: "survey_booked", has_page: true, google_account: "123-456-7890",
  blocker: null, ...over,
});

const sheet = (over: Record<string, unknown> = {}) => ({
  id: "sheet-1", campaign_id: "camp-1", client_id: "client-1", version: 1,
  derived: {
    campaign: {
      name: "Winter garage push", type: "search", daily_budget: 40,
      monthly_ceiling: 1200, geography: ["Portsmouth"], conversion_action: "survey_booked",
    },
    keyword_groups: [
      {
        name: "garage conversion",
        seeds: ["garage conversion", "garage conversion Portsmouth"],
        match: "phrase",
        note: "Seeded from a campaign content pillar. Not keyword research.",
      },
    ],
    negatives: ["free", "jobs", "diy"],
    destination: { url: "https://harbourhome.co.uk/garage-survey" },
    offer: { promise: "Dry in four days" },
  },
  missing: ["keyword_research"],
  plan_hash: "a".repeat(64), created_by_job_id: null,
  created_at: "2026-10-24T09:00:00Z", ...over,
});

function database(due: unknown[], sheets: unknown[] = []) {
  from.mockImplementation((table: string) => {
    const payload = () => (table === "google_ads_sheet_due" ? due : sheets);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: payload(), error: null }),
      then: (...a: Parameters<Promise<unknown>["then"]>) =>
        Promise.resolve({ data: payload(), error: null }).then(...a),
    });
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  database([row()]);
  enqueueAgentJob.mockResolvedValue("job-1");
});

describe("it never claims it can build", () => {
  it("says the automated build is not built, with no button to press", async () => {
    render(<GoogleAdsStudioPanel tab="build" />);
    expect(await screen.findByText(/Not built, and this page says so/)).toBeInTheDocument();
    expect(screen.getByText(/reserved action with no/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says a recorded credential is not used to build anything", async () => {
    render(<GoogleAdsStudioPanel tab="account" />);
    expect(await screen.findByText("123-456-7890")).toBeInTheDocument();
    expect(screen.getByText(/not used to build anything/)).toBeInTheDocument();
  });

  it("says the sheet works without a credential", async () => {
    database([row({ google_account: null })]);
    render(<GoogleAdsStudioPanel tab="account" />);
    expect(
      await screen.findByText(/a hand build is wanted precisely when the credential is missing/),
    ).toBeInTheDocument();
  });
});

describe("the sheet is a sheet, not a plan", () => {
  it("shows every seed's note, so nobody reads it as research", async () => {
    database([row({ sheet_id: "sheet-1", sheet_version: 1, missing: ["keyword_research"] })], [sheet()]);
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(
      await screen.findByText("Seeded from a campaign content pillar. Not keyword research."),
    ).toBeInTheDocument();
  });

  it("lists what the sheet does not know beside what it does", async () => {
    database(
      [row({ sheet_id: "sheet-1", sheet_version: 1, missing: ["keyword_research", "approved_ad_copy"] })],
      [sheet({ missing: ["keyword_research", "approved_ad_copy"] })],
    );
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(
      await screen.findByText(/Still needed before this is a plan: keyword_research, approved_ad_copy/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Seeds are a starting point for research, not research/)).toBeInTheDocument();
  });

  it("says there is nothing to seed from rather than showing an empty list", async () => {
    database(
      [row({ sheet_id: "sheet-1", sheet_version: 1 })],
      [sheet({ derived: { ...sheet().derived, keyword_groups: [] } })],
    );
    render(<GoogleAdsStudioPanel tab="sheet" />);
    // An empty list would read as "no keywords needed".
    expect(
      await screen.findByText(/no content pillars and no signed offer/),
    ).toBeInTheDocument();
  });

  it("shows the budget ceiling so nobody has to do the arithmetic", async () => {
    database([row({ sheet_id: "sheet-1", sheet_version: 1 })], [sheet()]);
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(await screen.findByText(/ceiling 1200 per 30 days/)).toBeInTheDocument();
  });
});

describe("deriving one", () => {
  it("queues the sheet agent, and says it calls nothing", async () => {
    render(<GoogleAdsStudioPanel tab="sheet" />);
    await userEvent.click(await screen.findByRole("button", { name: "Derive the sheet" }));
    await waitFor(() =>
      expect(enqueueAgentJob).toHaveBeenCalledWith({
        agentKey: "google_ads_sheet",
        clientId: "client-1",
        inputTable: "client_campaigns",
        inputId: "camp-1",
      }),
    );
    expect(await screen.findByText(/calls nothing/)).toBeInTheDocument();
  });

  it("shows the blocker the database gave instead of offering a broken sheet", async () => {
    database([
      row({
        daily_budget: null,
        blocker: "No daily budget is set, so the sheet cannot say what to spend.",
      }),
    ]);
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(
      await screen.findByText("No daily budget is set, so the sheet cannot say what to spend."),
    ).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
  });

  it("offers to derive again once a sheet exists", async () => {
    database([row({ sheet_id: "sheet-1", sheet_version: 1, missing: ["keyword_research"] })], [sheet()]);
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(await screen.findByRole("button", { name: "Derive again" })).toBeInTheDocument();
  });

  it("says plainly when there is no paid Google campaign", async () => {
    database([]);
    render(<GoogleAdsStudioPanel tab="sheet" />);
    expect(
      await screen.findByText("No paid Google campaign yet — create one in Campaign Factory"),
    ).toBeInTheDocument();
  });
});
