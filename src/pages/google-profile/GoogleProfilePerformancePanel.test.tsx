import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));

import { GoogleProfilePerformancePanel } from "./GoogleProfilePerformancePanel";

const location = { id: "location-1", title: "Main office",
  location_ref: "accounts/123/locations/456", verification_state: "verified" };
let runs: unknown[];
let points: unknown[];

beforeEach(() => {
  vi.clearAllMocks(); runs = []; points = [];
  rpc.mockResolvedValue({ data: "job-1", error: null });
  from.mockImplementation((table: string) => {
    const result = () => Promise.resolve({ data: table === "google_profile_performance_current_v8"
      ? runs : points, error: null });
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: () => chain, in: () => chain,
      then: (...args: Parameters<Promise<unknown>["then"]>) => result().then(...args) });
    return chain;
  });
});

describe("Business Profile performance view", () => {
  it("keeps absent provider coverage unknown and queues only a read job", async () => {
    render(<GoogleProfilePerformancePanel clientId="client-1" locations={[location]} />);
    expect(await screen.findByText(/Metrics are unknown/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read profile metrics" }));
    expect(rpc).toHaveBeenCalledWith("request_google_profile_performance_read_v8", {
      p_location_id: "location-1",
    });
    expect(await screen.findByText(/job queued/)).toBeInTheDocument();
  });

  it("shows partial dated coverage and leaves absent metrics unknown", async () => {
    runs = [{ id: "run-1", location_id: "location-1", fetched_at: "2026-11-19T10:00:00Z",
      from_date: "2026-11-01", through_date: "2026-11-02",
      observed_metrics: ["WEBSITE_CLICKS"] }];
    points = [{ run_id: "run-1", metric: "WEBSITE_CLICKS", day: "2026-11-01", value: 4 }];
    render(<GoogleProfilePerformancePanel clientId="client-1" locations={[location]} />);
    expect(await screen.findByText(/1\/2 dated values returned; other dates unknown/))
      .toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown")).toHaveLength(6);
  });

  it("does not request metrics for an unverified location", async () => {
    render(<GoogleProfilePerformancePanel clientId="client-1" locations={[
      { ...location, verification_state: "unverified" },
    ]} />);
    expect(await screen.findByRole("button", { name: "Read profile metrics" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
