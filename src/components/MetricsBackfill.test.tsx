import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
let coverage: unknown[] = [];
let pulls: unknown[] = [];

vi.mock("../lib/supabase", () => {
  function table(name: string) {
    const result = name === "metrics_coverage" ? { data: coverage, error: null } : { data: pulls, error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      limit: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });
    return chain;
  }
  return { supabase: { from: (n: string) => table(n), rpc: (...a: unknown[]) => rpc(...a) } };
});

import { MetricsBackfill } from "./MetricsBackfill";

beforeEach(() => {
  vi.clearAllMocks();
  coverage = [
    {
      surface: "paid",
      first_day: "2026-09-01",
      last_day: "2026-09-30",
      days_with_data: 30,
      days_missing_inside: 0,
      last_fetched_at: null,
    },
  ];
  pulls = [];
  rpc.mockImplementation(async (name: string) => {
    if (name === "max_backfill_days") return { data: 400, error: null };
    return { data: ["job-1", "job-2"], error: null };
  });
});

describe("pulling history", () => {
  it("shows what is already on file before asking for more", async () => {
    // A date picker over a guess is how a person re-pulls a month that is
    // already complete and pays for it.
    render(<MetricsBackfill clientId="client-1" />);
    expect(await screen.findByText(/30 days from 2026-09-01 to 2026-09-30, with no gaps/)).toBeInTheDocument();
    expect(screen.getByText(/No organic metrics on file/)).toBeInTheDocument();
  });

  it("calls request_metrics_backfill with the window and surface chosen", async () => {
    render(<MetricsBackfill clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /last 7 days/i }));
    await userEvent.selectOptions(screen.getByLabelText(/surface/i), "paid");
    await userEvent.click(screen.getByRole("button", { name: /^pull 7 days$/i }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "request_metrics_backfill",
        expect.objectContaining({ p_client_id: "client-1", p_surface: "paid" }),
      ),
    );
    const args = rpc.mock.calls.find((c) => c[0] === "request_metrics_backfill")![1] as {
      p_since: string;
      p_until: string;
    };
    // Seven days, ending yesterday rather than today.
    expect(Date.parse(args.p_until)).toBeLessThan(Date.now());
  });

  it("sends nothing for the surface when both were asked for", async () => {
    render(<MetricsBackfill clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /last 7 days/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pull 7 days$/i }));
    const args = rpc.mock.calls.find((c) => c[0] === "request_metrics_backfill")![1] as {
      p_surface?: string;
    };
    // Omitted rather than null. The function defaults p_surface to null, so
    // leaving it out is the same request and is what the generated
    // signature types: nothing is sent, which is what this test is about.
    expect(args.p_surface).toBeUndefined();
  });

  it("says how many pulls were queued and that they cost quota", async () => {
    render(<MetricsBackfill clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /last 7 days/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pull 7 days$/i }));
    expect(await screen.findByText(/Queued 2 pulls/)).toBeInTheDocument();
    expect(screen.getByText(/client's own API quota/)).toBeInTheDocument();
  });

  it("shows what the database said when it refused", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "max_backfill_days") return { data: 400, error: null };
      return { data: null, error: { message: "That exact window is already being pulled." } };
    });
    render(<MetricsBackfill clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /last 7 days/i }));
    await userEvent.click(screen.getByRole("button", { name: /^pull 7 days$/i }));
    expect(await screen.findByText(/already being pulled/)).toBeInTheDocument();
  });

  it("refuses a window the database would refuse, before the round trip", async () => {
    render(<MetricsBackfill clientId="client-1" />);
    await screen.findByRole("button", { name: /last 7 days/i });
    const [from] = screen.getAllByLabelText(/^from$/i);
    await userEvent.clear(from!);
    await userEvent.type(from!, "2030-01-01");

    expect(await screen.findByText(/starts after it ends|ends in the future/)).toBeInTheDocument();
    const pull = screen.getByRole("button", { name: /^pull/i });
    expect(pull).toBeDisabled();
    expect(rpc).not.toHaveBeenCalledWith("request_metrics_backfill", expect.anything());
  });

  it("lists what is being pulled, and says whether a person asked for it", async () => {
    pulls = [
      {
        job_id: "j1",
        surface: "paid",
        since: "2026-08-01",
        until: "2026-08-31",
        asked_for_by_hand: true,
        status: "running",
        error: null,
      },
      {
        job_id: "j2",
        surface: "organic",
        since: "2026-10-01",
        until: "2026-10-07",
        asked_for_by_hand: false,
        status: "queued",
        error: null,
      },
    ];
    render(<MetricsBackfill clientId="client-1" />);
    expect(await screen.findByText(/asked for by hand/)).toBeInTheDocument();
    // "daily sync" also appears in the section's own intro, so match the
    // row rather than the phrase.
    expect(screen.getByText(/organic · 2026-10-01 to 2026-10-07 · queued · daily sync/)).toBeInTheDocument();
  });

  it("says why a pull is held rather than showing it as simply queued", async () => {
    pulls = [
      {
        job_id: "j1",
        surface: "paid",
        since: "2026-08-01",
        until: "2026-08-31",
        asked_for_by_hand: true,
        status: "paused",
        error: "Spent $500.00 of its $500.00 cap for the month.",
      },
    ];
    render(<MetricsBackfill clientId="client-1" />);
    expect(await screen.findByText(/held: Spent \$500.00/)).toBeInTheDocument();
  });

  it("does not list a finished pull as still running", async () => {
    pulls = [
      {
        job_id: "j1",
        surface: "paid",
        since: "2026-08-01",
        until: "2026-08-31",
        asked_for_by_hand: true,
        status: "completed",
        error: null,
      },
    ];
    render(<MetricsBackfill clientId="client-1" />);
    await screen.findByRole("button", { name: /last 7 days/i });
    expect(screen.queryByText(/Being pulled now/)).not.toBeInTheDocument();
  });
});
