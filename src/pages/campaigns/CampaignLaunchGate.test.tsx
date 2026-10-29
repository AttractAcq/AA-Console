import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The launch gate — G08.
 *
 * The whole point is that "we did our part" and "it is live" are different
 * facts, so what is pinned here is that the screen never lets the first be
 * read as the second: approvals being complete does not render as Live, the
 * verdict comes from the database rather than being composed here, and the
 * two reasons for an absent spend figure are shown differently.
 */
const { fetchLaunchSteps } = vi.hoisted(() => ({ fetchLaunchSteps: vi.fn() }));

vi.mock("../../lib/campaignLaunch", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/campaignLaunch");
  return { ...actual, fetchLaunchSteps };
});

import { CampaignLaunchGate } from "./CampaignLaunchGate";

const due = (over: Record<string, unknown> = {}) =>
  ({
    campaign_id: "camp-1",
    client_id: "client-1",
    name: "Garage conversions — R1",
    acquisition_mode: "paid",
    paid_platform: "meta",
    template: "R1",
    status: "active",
    required_actions: 2,
    actions_done: 2,
    first_blocker: null,
    posts_published: 0,
    spend_bindable: true,
    spend_observed: 0,
    spending_days: 0,
    pages_published: 1,
    pages_probed: 1,
    proof_placed: 0,
    leads_attributed: 0,
    live: false,
    verdict:
      "Everything approved and the objects exist, paused. No spend observed, so a person has not switched them on in Ads Manager.",
    warning: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  fetchLaunchSteps.mockResolvedValue([]);
});

describe("the launch gate", () => {
  it("reads Not live when every action is done but nothing has happened outside", async () => {
    render(<CampaignLaunchGate due={due()} />);
    expect(screen.getByText("Not live")).toBeTruthy();
    expect(screen.getByText(/has not switched them on in Ads Manager/)).toBeTruthy();
    // Our part being complete must not read as live.
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("reads Live once the database says so", async () => {
    render(
      <CampaignLaunchGate
        due={due({ live: true, spending_days: 3, verdict: "Live: spend on 3 day(s)." })}
      />,
    );
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Live: spend on 3 day(s).")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows spend as unknown, not zero, when no external id is bound", async () => {
    render(
      <CampaignLaunchGate
        due={due({
          spend_bindable: false,
          verdict:
            "Everything approved, and no external campaign id is bound, so whether it is spending cannot be known from here. Bind the id.",
        })}
      />,
    );
    // Zero would be a claim. Unknown is the truth.
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(
      screen.getByText(/different problem from a campaign that is bound and spending nothing/),
    ).toBeTruthy();
  });

  it("counts posts rather than spend for an organic campaign", async () => {
    render(
      <CampaignLaunchGate
        due={due({
          acquisition_mode: "organic",
          paid_platform: null,
          posts_published: 4,
          live: true,
          verdict: "Live: 4 post(s) published.",
        })}
      />,
    );
    expect(screen.getByText("Posts published")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByText("Spending days")).toBeNull();
  });

  it("surfaces the published-but-unprobed warning", async () => {
    render(
      <CampaignLaunchGate
        due={due({ pages_probed: 0, warning: "1 published page(s) have no passing form probe." })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("no passing form probe");
  });

  it("loads the per-action breakdown only when asked", async () => {
    fetchLaunchSteps.mockResolvedValue([
      {
        campaign_id: "camp-1", item_key: "distribution", action_key: "google_ad_build",
        action_supported: false, blocker: "No adapter performs google_ad_build.",
      },
    ]);
    render(<CampaignLaunchGate due={due()} />);
    expect(fetchLaunchSteps).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "What is still ours to do" }));
    await waitFor(() => expect(fetchLaunchSteps).toHaveBeenCalledWith("camp-1"));
    expect(await screen.findByText("No adapter performs google_ad_build.")).toBeTruthy();
    expect(screen.getByText("no adapter")).toBeTruthy();
  });
});
