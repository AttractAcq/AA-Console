import { useCallback, useEffect, useState } from "react";

import { Panel } from "../Panel";
import { supabase } from "../../lib/supabase";

/**
 * Every switch for one client, in one place.
 *
 * The switches were spread across four screens and one of them existed on no
 * screen at all, which is how the engine sat switched off globally for hours
 * while each client's own line read as though it were running. A person
 * asking "what is this system actually doing for this client right now"
 * had to know which four pages to visit and which gate each one owned.
 *
 * So the list is declarative. A new switch is a row in SWITCHES, not more
 * markup, because the notes are explicit that every automatic system that
 * can be turned on or off ends up here.
 *
 * WHY EACH ROW SAYS WHAT ELSE HAS TO BE TRUE
 *
 * Several of these are necessary but not sufficient. Publishing needs the
 * runtime's own PUBLISH_ENABLED, which is a deployment variable and cannot be
 * read or set from the browser. Campaign actions are held in the runtime
 * regardless of this switch. A toggle that looks like it finished the job
 * when it did not is worse than no toggle, so each row carries the rest of
 * the sentence.
 *
 * WHY THERE IS NO INSTANT TOGGLE
 *
 * The Engine screen's reasoning, kept: changing a setting and starting to
 * spend a client's money should not be the same gesture. Each row is an
 * explicit button, and the ones that begin spending or send something
 * outward say so in the row rather than in a tooltip.
 */

type EngineSettings = {
  enabled: boolean;
  publishing_enabled: boolean;
  proof_publishing_enabled: boolean;
  campaign_actions_enabled: boolean;
  lead_magnet_delivery_enabled: boolean;
  outbound_messaging_enabled: boolean;
  auto_approve_ideas: boolean;
  auto_approve_briefs: boolean;
};

type SwitchState = {
  settings: EngineSettings | null;
  engineRunning: boolean;
  bookingEnabled: boolean | null;
};

/** What a row needs to render itself and to write itself back. */
type SwitchRow = {
  key: string;
  label: string;
  /** What it gates, in the present tense, when it is on. */
  on: string;
  /** What is true while it is off. */
  off: string;
  /** The rest of the sentence: what else has to hold for this to matter. */
  caveat?: string;
  value: (state: SwitchState) => boolean | null;
  /** The call that writes it. `client` is substituted by the panel. */
  write?: (next: boolean) => { fn: string; args: Record<string, unknown> };
  /**
   * Shown as state, not as a control. The system-wide switch is already a
   * live control on the admin Engine screen, and two buttons on two screens
   * writing the same singleton row is a way to switch off every client by
   * accident from a page that is otherwise about one of them.
   */
  readOnly?: { because: string };
};

const SWITCHES: SwitchRow[] = [
  {
    key: "engine_running",
    label: "Content engine, system-wide",
    on: "The hourly tick considers every switched-on client.",
    off: "No client runs, whatever its own switch says.",
    caveat: "This one is not per-client. While it is off, every client is stopped at once.",
    value: (s) => s.engineRunning,
    readOnly: { because: "Changed on the Engine screen, which is where it applies to every client." },
  },
  {
    key: "engine",
    label: "Content engine, this client",
    on: "Slots are planned and walked to the approval queue.",
    off: "Nothing is planned or produced for this client.",
    caveat: "Needs a spend cap for the current month, or the tick skips this client and says so.",
    value: (s) => s.settings?.enabled ?? null,
    write: (next) => ({ fn: "set_engine_enabled", args: { p_enabled: next } }),
  },
  {
    key: "auto_approve_ideas",
    label: "Choose ideas by policy",
    on: "The engine picks each slot's idea and moves it on.",
    off: "A person picks every idea, and the slot waits at ideating until they do.",
    caveat: "Off means the pipeline stops at the second of nine stages, however green everything else looks.",
    value: (s) => s.settings?.auto_approve_ideas ?? null,
    write: (next) => ({ fn: "set_engine_settings", args: { p_auto_approve_ideas: next } }),
  },
  {
    key: "auto_approve_briefs",
    label: "Approve briefs by policy",
    on: "A brief goes to build without waiting for a person.",
    off: "A person approves every brief before anything is built.",
    value: (s) => s.settings?.auto_approve_briefs ?? null,
    write: (next) => ({ fn: "set_engine_settings", args: { p_auto_approve_briefs: next } }),
  },
  {
    key: "publishing",
    label: "Publish approved posts",
    on: "An approved post goes out on this client's own accounts at its planned time.",
    off: "Approved posts sit on the calendar. Nothing reaches a real account.",
    caveat: "The runtime's own PUBLISH_ENABLED must also be on. That is a deployment variable, not a setting here.",
    value: (s) => s.settings?.publishing_enabled ?? null,
    write: (next) => ({ fn: "set_publishing_enabled", args: { p_enabled: next } }),
  },
  {
    key: "proof_publishing",
    label: "Place approved proof",
    on: "Approved proof is placed on its destination.",
    off: "Proof placements wait, however they were approved.",
    caveat: "Only Google Business Profile has transport in the runtime today; the other destinations are recorded as unsupported.",
    value: (s) => s.settings?.proof_publishing_enabled ?? null,
    write: (next) => ({ fn: "set_proof_publishing_enabled", args: { p_enabled: next } }),
  },
  {
    key: "campaign_actions",
    label: "Execute approved campaign actions",
    on: "Approved campaign actions are claimed for execution.",
    off: "Approved actions wait and nothing external happens.",
    caveat:
      "Held in the runtime whatever this says: the generic claim has no atomic handler-ownership gate yet, so switching this on produces a visible job failure rather than an execution.",
    value: (s) => s.settings?.campaign_actions_enabled ?? null,
    write: (next) => ({ fn: "set_campaign_actions_enabled", args: { p_enabled: next } }),
  },
  {
    key: "outbound_messaging",
    label: "Send outbound messages",
    on: "Leads are enrolled in approved sequences and messages are sent.",
    off: "Nobody is enrolled and nothing is sent.",
    caveat: "The runtime's OUTBOUND_MESSAGING_ENABLED must also be on, and every message still needs its own approval.",
    value: (s) => s.settings?.outbound_messaging_enabled ?? null,
    write: (next) => ({ fn: "set_outbound_messaging_enabled", args: { p_enabled: next } }),
  },
  {
    key: "lead_magnet_delivery",
    label: "Deliver lead magnets",
    on: "An opted-in person receives the magnet they asked for.",
    off: "Opt-ins are recorded and nothing is delivered.",
    value: (s) => s.settings?.lead_magnet_delivery_enabled ?? null,
    write: (next) => ({ fn: "set_lead_magnet_delivery_enabled", args: { p_enabled: next } }),
  },
  {
    key: "booking",
    label: "Let prospects book a call",
    on: "A prospect can take a slot in this client's week.",
    off: "No slot can be taken, whatever the booking page shows.",
    caveat: "Needs booking hours recorded first, or switching it on offers slots that do not exist.",
    value: (s) => s.bookingEnabled,
    write: (next) => ({ fn: "set_client_booking_enabled_v6", args: { p_enabled: next } }),
  },
];

export function ClientSwitchPanel({ clientId }: { clientId: string }) {
  const [state, setState] = useState<SwitchState>({
    settings: null,
    engineRunning: false,
    bookingEnabled: null,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [settings, controls, booking] = await Promise.all([
      supabase.from("client_engine_settings").select("*").eq("client_id", clientId).maybeSingle(),
      supabase.from("engine_controls").select("enabled").maybeSingle(),
      supabase.from("client_booking_settings").select("enabled").eq("client_id", clientId).maybeSingle(),
    ]);
    const failed = settings.error ?? controls.error ?? booking.error;
    if (failed) setError(failed.message);
    setState({
      settings: (settings.data as EngineSettings) ?? null,
      engineRunning: Boolean((controls.data as { enabled?: boolean } | null)?.enabled),
      // null, not false: a client with no booking rules yet is a different
      // state from one whose booking is switched off.
      bookingEnabled: (booking.data as { enabled?: boolean } | null)?.enabled ?? null,
    });
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function flip(row: SwitchRow, next: boolean) {
    setBusy(row.key);
    setError(null);
    setNote(null);
    if (!row.write) return;
    const { fn, args } = row.write(next);
    // Every writer still reachable from here takes the client.
    const payload = { p_client_id: clientId, ...args };
    const { error: rpcError } = await supabase.rpc(fn as never, payload as never);
    setBusy(null);
    if (rpcError) {
      // The refusal is the useful part: these functions explain themselves.
      setError(rpcError.message);
      return;
    }
    setNote(`${row.label} is now ${next ? "on" : "off"}.`);
    await refresh();
  }

  if (loading) return <Panel title="Switches"><p className="text-sm text-muted-foreground">Loading…</p></Panel>;

  // The system-wide row is context, so it is not counted among the switches
  // this panel can change -- "3 of 9 on" should describe this client.
  const controllable = SWITCHES.filter((row) => !row.readOnly);
  const on = controllable.filter((row) => row.value(state) === true).length;

  return (
    <Panel title={`Switches — ${on} of ${controllable.length} on`}>
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="mb-3 text-sm text-brand-strong">
          {note}
        </p>
      )}
      <ul className="divide-y divide-border">
        {SWITCHES.map((row) => {
          const value = row.value(state);
          // A switch whose row does not exist yet cannot be flipped from
          // here: the thing it belongs to has to be configured first.
          const unset = value === null;
          return (
            <li key={row.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-card-foreground">{row.label}</p>
                <p className="text-sm text-muted-foreground">{value ? row.on : row.off}</p>
                {row.caveat && <p className="mt-1 text-xs text-muted-foreground">{row.caveat}</p>}
                {row.readOnly && (
                  <p className="mt-1 text-xs text-muted-foreground">{row.readOnly.because}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    value
                      ? "bg-brand-subtle text-brand-strong"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {unset ? "not set up" : value ? "on" : "off"}
                </span>
                {!row.readOnly && (
                <button
                  type="button"
                  disabled={busy !== null || unset}
                  onClick={() => void flip(row, !value)}
                  aria-label={`${value ? "Switch off" : "Switch on"} ${row.label}`}
                  className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
                    value
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-primary text-primary-foreground"
                  }`}
                >
                  {busy === row.key ? "…" : value ? "Switch off" : "Switch on"}
                </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
