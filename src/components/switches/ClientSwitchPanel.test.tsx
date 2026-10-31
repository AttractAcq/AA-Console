import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientSwitchPanel } from "./ClientSwitchPanel";

const rpc = vi.fn();

/**
 * Dispatch by table, as the Engine panel's test does and for the same reason:
 * the panel refreshes after every successful write, so queued one-shot
 * results run out and the refresh then reads undefined.
 */
const state = {
  settings: null as Record<string, unknown> | null,
  controls: { enabled: false } as { enabled: boolean } | null,
  booking: null as { enabled: boolean } | null,
  error: null as string | null,
};

const SETTINGS = {
  enabled: false,
  publishing_enabled: false,
  proof_publishing_enabled: false,
  campaign_actions_enabled: false,
  lead_magnet_delivery_enabled: false,
  outbound_messaging_enabled: false,
  auto_approve_ideas: false,
  auto_approve_briefs: false,
};

function result(table: string) {
  if (state.error) return { data: null, error: { message: state.error } };
  switch (table) {
    case "client_engine_settings":
      return { data: state.settings, error: null };
    case "engine_controls":
      return { data: state.controls, error: null };
    default:
      return { data: state.booking, error: null };
  }
}

const from = vi.fn((table: string) => {
  const payload = () => Promise.resolve(result(table));
  const chain = { maybeSingle: payload, then: (...a: Parameters<Promise<unknown>["then"]>) => payload().then(...a) };
  return { select: () => ({ eq: () => chain, maybeSingle: payload }) };
});

vi.mock("../../lib/supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...(a as [string])), rpc: (...a: unknown[]) => rpc(...(a as [])) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { ...SETTINGS };
  state.controls = { enabled: false };
  state.booking = null;
  state.error = null;
  rpc.mockResolvedValue({ error: null });
});

describe("every switch in one place", () => {
  it("counts how many are on, so the heading answers the question first", async () => {
    // The system-wide switch is deliberately on and deliberately not
    // counted: nine, not ten, and the two are this client's own.
    state.controls = { enabled: true };
    state.settings = { ...SETTINGS, enabled: true, auto_approve_ideas: true };
    render(<ClientSwitchPanel clientId="c1" />);
    expect(await screen.findByText(/Switches — 2 of 9 on/)).toBeInTheDocument();
  });

  it("lists each switch with what is true while it is off", async () => {
    render(<ClientSwitchPanel clientId="c1" />);
    expect(await screen.findByText("Content engine, this client")).toBeInTheDocument();
    expect(screen.getByText(/No client runs, whatever its own switch says/)).toBeInTheDocument();
    expect(screen.getByText(/Approved posts sit on the calendar/)).toBeInTheDocument();
  });

  it("names what else has to be true, so a flipped switch is not mistaken for a finished job", async () => {
    render(<ClientSwitchPanel clientId="c1" />);
    // Publishing needs a deployment variable the browser cannot set.
    expect(await screen.findByText(/PUBLISH_ENABLED must also be on/)).toBeInTheDocument();
    // And campaign actions are held in the runtime regardless of this switch.
    expect(screen.getByText(/produces a visible job failure rather than an execution/)).toBeInTheDocument();
  });

  it("writes a per-client switch with the client on it", async () => {
    render(<ClientSwitchPanel clientId="c1" />);
    await userEvent.click(await screen.findByLabelText("Switch on Content engine, this client"));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_engine_enabled", { p_client_id: "c1", p_enabled: true }),
    );
  });

  it("shows the system-wide switch as state, with no control to flip it", async () => {
    // It is a live control on the admin Engine screen. A second button here
    // would let someone stop every client from a page about one of them, so
    // this row explains the state and says where it is changed.
    render(<ClientSwitchPanel clientId="c1" />);
    expect(await screen.findByText("Content engine, system-wide")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Content engine, system-wide/)).toBeNull();
    expect(screen.getByText(/Changed on the Engine screen/)).toBeInTheDocument();
  });

  it("never writes the system-wide singleton from the client dashboard", async () => {
    render(<ClientSwitchPanel clientId="c1" />);
    await userEvent.click(await screen.findByLabelText("Switch on Content engine, this client"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc.mock.calls.map((call) => call[0])).not.toContain("set_engine_running");
  });

  it("switches a live one back off", async () => {
    state.settings = { ...SETTINGS, outbound_messaging_enabled: true };
    render(<ClientSwitchPanel clientId="c1" />);
    await userEvent.click(await screen.findByLabelText("Switch off Send outbound messages"));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_outbound_messaging_enabled", {
        p_client_id: "c1",
        p_enabled: false,
      }),
    );
  });

  it("will not offer to flip something that has not been set up", async () => {
    // No booking rules recorded, which is a different state from switched off.
    render(<ClientSwitchPanel clientId="c1" />);
    expect(await screen.findByText("not set up")).toBeInTheDocument();
    expect(screen.getByLabelText("Switch on Let prospects book a call")).toBeDisabled();
  });

  it("offers booking once its rules exist", async () => {
    state.booking = { enabled: false };
    render(<ClientSwitchPanel clientId="c1" />);
    const button = await screen.findByLabelText("Switch on Let prospects book a call");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_client_booking_enabled_v6", {
        p_client_id: "c1",
        p_enabled: true,
      }),
    );
  });

  it("shows the refusal, because these functions explain themselves", async () => {
    rpc.mockResolvedValue({ error: { message: "This client has no bookable hours recorded." } });
    state.booking = { enabled: false };
    render(<ClientSwitchPanel clientId="c1" />);
    await userEvent.click(await screen.findByLabelText("Switch on Let prospects book a call"));
    expect(await screen.findByRole("alert")).toHaveTextContent("no bookable hours recorded");
  });

  it("reports a read failure rather than rendering every switch as off", async () => {
    state.error = "permission denied for table client_engine_settings";
    render(<ClientSwitchPanel clientId="c1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});
