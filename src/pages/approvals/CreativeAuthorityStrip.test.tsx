import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who decides this is good enough — G12.
 *
 * The strip exists to make three previously unsayable things visible, and
 * those are what is pinned: who holds the creative director seat, that the
 * "video approval manager" referred to elsewhere is the assigned SMM, and
 * which seat each decision came from. Plus the one thing a toggle like this
 * must never do quietly: narrow who may approve without saying so.
 */
const { fetchCreativeAuthority, fetchCreativeDecisions, setCreativeDirectorRequired } =
  vi.hoisted(() => ({
    fetchCreativeAuthority: vi.fn(),
    fetchCreativeDecisions: vi.fn(),
    setCreativeDirectorRequired: vi.fn(),
  }));

vi.mock("../../lib/creativeAuthority", () => ({
  fetchCreativeAuthority: (...a: unknown[]) => fetchCreativeAuthority(...(a as [string])),
  fetchCreativeDecisions: (...a: unknown[]) => fetchCreativeDecisions(...(a as [string])),
  setCreativeDirectorRequired: (...a: unknown[]) =>
    setCreativeDirectorRequired(...(a as [string, boolean])),
}));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "c1" }) }));

import { CreativeAuthorityStrip } from "./CreativeAuthorityStrip";

const authority = (over: Record<string, unknown> = {}) => ({
  client_id: "c1",
  client_name: "Harbour Dental",
  smm_user_id: "smm-user",
  creative_director_user_id: "cd-user",
  creative_director_required: false,
  problem: null,
  ...over,
});

const decision = (over: Record<string, unknown> = {}) => ({
  client_id: "c1",
  asset_id: "a1",
  asset_title: "Winter reel",
  media_type: "video",
  content_format: "reel",
  decision: "approved",
  reason: null,
  reviewed_by: "cd-user",
  seat: "creative_director",
  decided_at: "2026-10-24T10:00:00Z",
  still_in_seat: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchCreativeAuthority.mockResolvedValue(authority());
  fetchCreativeDecisions.mockResolvedValue([decision()]);
  setCreativeDirectorRequired.mockResolvedValue(undefined);
});

describe("the creative seats", () => {
  it("names both seats, and says the video approval manager is the SMM", async () => {
    render(<CreativeAuthorityStrip />);
    expect(await screen.findByText("cd-user")).toBeTruthy();
    expect(screen.getByText("smm-user")).toBeTruthy();
    expect(screen.getByText(/what every screen calls the .video approval manager./)).toBeTruthy();
  });

  it("says plainly that anyone with access can approve while the toggle is off", async () => {
    render(<CreativeAuthorityStrip />);
    expect(
      await screen.findByText(/Anyone with access to this client can approve creative/),
    ).toBeTruthy();
  });

  it("says what changes when the requirement is on, including that rejections are not blocked", async () => {
    fetchCreativeAuthority.mockResolvedValue(authority({ creative_director_required: true }));
    render(<CreativeAuthorityStrip />);
    expect(await screen.findByText("Creative director sign-off required")).toBeTruthy();
    expect(screen.getByText(/Rejections are never blocked/)).toBeTruthy();
  });

  it("turns the requirement on through the one call that does it", async () => {
    render(<CreativeAuthorityStrip />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Require a creative director" }),
    );
    await waitFor(() => expect(setCreativeDirectorRequired).toHaveBeenCalledWith("c1", true));
  });

  it("surfaces the view's problem sentence when a required seat is empty", async () => {
    fetchCreativeAuthority.mockResolvedValue(authority({
      creative_director_user_id: null,
      creative_director_required: true,
      problem: "Creative director sign-off is required for this client and nobody holds the seat, so no creative can be approved.",
    }));
    render(<CreativeAuthorityStrip />);
    const alerts = await waitFor(() => screen.getAllByRole("alert"));
    expect(alerts.some((a) => a.textContent?.includes("nobody holds the seat"))).toBe(true);
  });

  it("counts decisions made from no named seat without calling them wrong", async () => {
    fetchCreativeDecisions.mockResolvedValue([
      decision({ seat: "other", reviewed_by: "someone" }),
      decision({ asset_id: "a2" }),
    ]);
    render(<CreativeAuthorityStrip />);
    expect(
      await screen.findByText(/1 of the last 2 decisions were made by somebody holding no/),
    ).toBeTruthy();
    expect(screen.getByText(/That is allowed; it is shown because a pattern of it is worth/))
      .toBeTruthy();
  });

  it("shows the seat each decision was made from, only when asked", async () => {
    render(<CreativeAuthorityStrip />);
    await waitFor(() => expect(fetchCreativeDecisions).toHaveBeenCalled());
    expect(screen.queryByText("creative_director")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Recent decisions" }));
    expect(await screen.findByText("creative_director")).toBeTruthy();
    expect(screen.getByText("Winter reel")).toBeTruthy();
  });
});
