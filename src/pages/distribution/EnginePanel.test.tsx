import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnginePanel } from "./EnginePanel";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const order = vi.fn();
const eq = vi.fn(() => ({ maybeSingle, order }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "c1" }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...(a as [])), rpc: (...a: unknown[]) => rpc(...(a as [])) },
}));

/** engine_readiness, settings, platforms, windows — in the order the panel asks. */
function withState(readiness: Record<string, unknown>, windows: unknown[] = []) {
  maybeSingle
    .mockResolvedValueOnce({ data: readiness, error: null })
    .mockResolvedValueOnce({
      data: { plan_horizon_days: 14, min_qa_score: 70, approval_mode: "per_post", auto_approve_ideas: false, auto_approve_briefs: false, max_jobs_in_flight: 3 },
      error: null,
    });
  eq.mockReturnValue({ maybeSingle, order });
  order.mockResolvedValue({ data: windows, error: null });
  // The platforms query ends at .eq(), so it resolves as a thenable.
  eq.mockImplementation(() => {
    const result = { maybeSingle, order };
    return Object.assign(Promise.resolve({ data: [], error: null }), result);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
