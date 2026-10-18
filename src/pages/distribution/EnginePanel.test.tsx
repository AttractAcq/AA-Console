import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnginePanel } from "./EnginePanel";

const rpc = vi.fn();

/**
 * Dispatch by table, not by call order.
 *
 * The first version of this mock queued results with mockResolvedValueOnce,
 * which ran out the moment the panel refreshed after a successful save — the
 * refresh then read `undefined.error` and threw. It passed locally because
 * vitest reports that as an unhandled error rather than a failing test, and
 * CI counted it. Keying off the table name means any number of refreshes
 * behave the same, which is also what the panel actually does.
 */
type State = {
  readiness: Record<string, unknown> | null;
  windows: unknown[];
  platforms: unknown[];
  due: unknown[];
  publishing: boolean;
  /** A client with readiness but no settings row at all. */
  noSettings: boolean;
};
const state: State = {
  readiness: null,
  windows: [],
  platforms: [],
  due: [],
  publishing: false,
  noSettings: false,
};

const SETTINGS = {
  plan_horizon_days: 14,
  min_qa_score: 70,
  approval_mode: "per_post",
  auto_approve_ideas: false,
  auto_approve_briefs: false,
  max_jobs_in_flight: 3,
  publishing_enabled: false,
};

function result(table: string) {
  switch (table) {
    case "engine_readiness":
      return { data: state.readiness, error: null };
    case "client_engine_settings":
      return {
        data:
          state.readiness && !state.noSettings
            ? { ...SETTINGS, publishing_enabled: state.publishing }
            : null,
        error: null,
      };
    case "publish_due":
      return { data: state.due, error: null };
    case "client_engine_platforms":
      return { data: state.platforms, error: null };
    default:
      return { data: state.windows, error: null };
  }
}

const from = vi.fn((table: string) => {
  const payload = () => Promise.resolve(result(table));
  const chain = {
    maybeSingle: payload,
    order: payload,
    // The platforms query ends at .eq(), so the chain is itself awaitable.
    then: (...a: Parameters<Promise<unknown>["then"]>) => payload().then(...a),
  };
  return { select: () => ({ eq: () => chain }) };
});

vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "c1" }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...(a as [string])), rpc: (...a: unknown[]) => rpc(...(a as [])) },
}));

function withState(readiness: Record<string, unknown>, windows: unknown[] = []) {
  state.readiness = readiness;
  state.windows = windows;
  state.platforms = [];
  state.due = [];
  state.publishing = false;
  state.noSettings = false;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.readiness = null;
  state.windows = [];
  state.platforms = [];
  state.due = [];
  state.publishing = false;
  rpc.mockResolvedValue({ error: null });
});

describe("the switch", () => {
  it("will not switch on a client that is not ready, and says what is missing", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "No posting windows", timezone: "Europe/London" });
    render(<EnginePanel />);

    const button = await screen.findByRole("button", { name: "Switch on" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Fix .No posting windows./)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("switches on a client that is ready", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "Ready, switched off", timezone: "Europe/London" });
    render(<EnginePanel />);

    const button = await screen.findByRole("button", { name: "Switch on" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_engine_enabled", { p_client_id: "c1", p_enabled: true }),
    );
  });

  it("offers off, with no preconditions, once it is running", async () => {
    withState({ client_id: "c1", enabled: true, readiness: "Running", timezone: "Europe/London" });
    render(<EnginePanel />);

    const button = await screen.findByRole("button", { name: "Switch off" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_engine_enabled", { p_client_id: "c1", p_enabled: false }),
    );
  });

  it("says which timezone the posts land in, since that is not obvious", async () => {
    withState({ client_id: "c1", enabled: true, readiness: "Running", timezone: "Pacific/Auckland" });
    render(<EnginePanel />);
    expect(await screen.findByText(/Pacific\/Auckland time/)).toBeInTheDocument();
  });

  it("surfaces a refusal from the database rather than looking switched on", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "Ready, switched off", timezone: "Europe/London" });
    rpc.mockResolvedValue({ error: { message: "This client has no posting windows." } });
    render(<EnginePanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Switch on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no posting windows/);
  });
});

describe("cadence and windows", () => {
  it("saves a platform's posts per week, and marks it inactive at zero", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "Ready, switched off", timezone: "Europe/London" });
    render(<EnginePanel />);

    const field = await screen.findByLabelText("Instagram posts per week");
    await userEvent.clear(field);
    await userEvent.type(field, "4");
    await userEvent.tab();
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_engine_platform", {
        p_client_id: "c1",
        p_platform: "instagram",
        p_posts_per_week: 4,
        p_active: true,
      }),
    );
  });

  it("adds a window as a weekday and a local range", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "No posting windows", timezone: "Europe/London" });
    render(<EnginePanel />);

    await userEvent.selectOptions(await screen.findByLabelText("Window day"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Add window" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("add_engine_window", {
        p_client_id: "c1",
        p_weekday: 3,
        p_starts_at: "09:00",
        p_ends_at: "11:00",
      }),
    );
  });

  it("shows a saved window as a day and a range, Monday first", async () => {
    withState({ client_id: "c1", enabled: true, readiness: "Running", timezone: "Europe/London" }, [
      { id: "w1", weekday: 1, starts_at: "09:00:00", ends_at: "11:00:00" },
      { id: "w2", weekday: 7, starts_at: "18:00:00", ends_at: "20:00:00" },
    ]);
    render(<EnginePanel />);
    expect(await screen.findByText("Monday 09:00–11:00")).toBeInTheDocument();
    expect(screen.getByText("Sunday 18:00–20:00")).toBeInTheDocument();
  });

  it("will not add a window that ends before it starts", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "No posting windows", timezone: "Europe/London" });
    render(<EnginePanel />);

    const start = await screen.findByLabelText("Window start");
    await userEvent.clear(start);
    await userEvent.type(start, "14:00");
    const end = screen.getByLabelText("Window end");
    await userEvent.clear(end);
    await userEvent.type(end, "10:00");

    expect(screen.getByRole("button", { name: "Add window" })).toBeDisabled();
  });
});

describe("how it decides", () => {
  it("saves the horizon without touching anything else", async () => {
    withState({ client_id: "c1", enabled: false, readiness: "Ready, switched off", timezone: "Europe/London" });
    render(<EnginePanel />);

    const field = await screen.findByLabelText("Plan ahead days");
    await userEvent.clear(field);
    await userEvent.type(field, "21");
    await userEvent.tab();
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_engine_settings", { p_client_id: "c1", p_plan_horizon_days: 21 }),
    );
  });

  it("says plainly that a policy approval is not the human one", async () => {
    withState({ client_id: "c1", enabled: true, readiness: "Running", timezone: "Europe/London" });
    render(<EnginePanel />);
    expect(
      await screen.findByText(/Neither replaces the human approval a post still needs/),
    ).toBeInTheDocument();
  });
});

describe("the second switch", () => {
  const ready = { client_id: "c1", enabled: true, readiness: "Running", active_platforms: 1, posts_per_week: 3, posting_windows: 1, active_pillars: 1, month_cap_usd: 500, timezone: "Europe/London" };

  it("is off even when the engine is on", async () => {
    // Making content and posting it on a client's own accounts are
    // different promises. One button for both means the day somebody
    // switches the engine on for a new client, that client's audience
    // hears from it.
    withState(ready);
    render(<EnginePanel />);
    expect(await screen.findByText(/Nothing is posted to this client's accounts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start publishing" })).toBeInTheDocument();
  });

  it("turns publishing on for this client and says the runtime must agree", async () => {
    withState(ready);
    rpc.mockResolvedValue({ error: null });
    render(<EnginePanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Start publishing" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_publishing_enabled", { p_client_id: "c1", p_enabled: true }),
    );
    expect(await screen.findByText(/runtime has to have it on too/)).toBeInTheDocument();
  });

  it("offers to stop once it is on", async () => {
    withState(ready);
    state.publishing = true;
    render(<EnginePanel />);
    expect(await screen.findByText(/Approved posts go out on this client's accounts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop publishing" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_publishing_enabled", { p_client_id: "c1", p_enabled: false }),
    );
  });

  it("does not claim a client with no settings at all is publishing", async () => {
    // The fallback is what a client who has never been configured reads,
    // and "posts go out on this client's accounts" would be a lie about a
    // real account.
    withState(ready);
    state.noSettings = true;
    render(<EnginePanel />);
    expect(await screen.findByText(/Nothing is posted to this client's accounts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start publishing" })).toBeInTheDocument();
  });

  it("is a separate act from switching the engine off", async () => {
    withState(ready);
    state.publishing = true;
    render(<EnginePanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_engine_enabled", { p_client_id: "c1", p_enabled: false }));
    expect(rpc).not.toHaveBeenCalledWith("set_publishing_enabled", expect.anything());
  });
});

describe("why nothing went out", () => {
  const ready = { client_id: "c1", enabled: true, readiness: "Running", active_platforms: 1, posts_per_week: 3, posting_windows: 1, active_pillars: 1, month_cap_usd: 500, timezone: "Europe/London" };

  it("says the blocker on each post rather than leaving a board to guess", async () => {
    withState(ready);
    state.due = [
      {
        post_id: "p1",
        platform: "instagram",
        scheduled_at: "2026-10-08T09:00:00Z",
        asset_title: "The Chain",
        publication_status: "scheduled",
        publish_attempts: 0,
        blocker: "Publishing is off for this client.",
      },
      {
        post_id: "p2",
        platform: "facebook",
        scheduled_at: "2026-10-08T10:00:00Z",
        asset_title: "The Step",
        publication_status: "scheduled",
        publish_attempts: 2,
        blocker: null,
      },
    ];
    render(<EnginePanel />);
    expect(await screen.findByText("Publishing is off for this client.")).toBeInTheDocument();
    expect(screen.getByText("Ready to go out.")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 ready/)).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("says nothing at all when there is nothing outstanding", async () => {
    withState(ready);
    render(<EnginePanel />);
    await screen.findByText(/Nothing is posted/);
    expect(screen.queryByText(/Waiting to go out/)).not.toBeInTheDocument();
  });
});
