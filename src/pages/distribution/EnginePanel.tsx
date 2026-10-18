import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { POST_PLATFORMS, platformLabel } from "../../lib/postPlatform";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Platform = Database["public"]["Enums"]["post_platform"];

/** The five calls this panel makes. Named so a typo is a type error. */
type EngineRpc =
  | "set_engine_settings"
  | "set_engine_enabled"
  | "set_engine_platform"
  | "add_engine_window"
  | "remove_engine_window"
  | "set_publishing_enabled";

/**
 * Whether the engine runs for this client, and what it does when it does.
 *
 * The switch is the point of this screen. Everything else is cadence, and
 * cadence is only interesting once something is running, so the readiness
 * line goes at the top and says the one thing that is stopping it rather
 * than leaving someone to work out which of four things is missing.
 *
 * Settings and the switch are separate calls in the database and separate
 * buttons here, on purpose: changing a cadence and starting to spend a
 * client's money should never be the same click.
 */

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Readiness = {
  client_id: string;
  enabled: boolean;
  readiness: string;
  active_platforms: number;
  posts_per_week: number;
  posting_windows: number;
  active_pillars: number;
  month_cap_usd: number | null;
  timezone: string;
};

type Settings = {
  plan_horizon_days: number;
  auto_approve_ideas: boolean;
  auto_approve_briefs: boolean;
  min_qa_score: number;
  approval_mode: string;
  max_jobs_in_flight: number;
  publishing_enabled: boolean;
};

/** One row of publish_due. `blocker` is null for anything that would go out. */
type DueRow = {
  post_id: string;
  platform: string | null;
  scheduled_at: string;
  asset_title: string | null;
  publication_status: string;
  publish_attempts: number | null;
  blocker: string | null;
};

type PlatformRow = { platform: Platform; posts_per_week: number; active: boolean };
type WindowRow = { id: string; weekday: number; starts_at: string; ends_at: string };

export function EnginePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [platforms, setPlatforms] = useState<PlatformRow[]>([]);
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [due, setDue] = useState<DueRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setError(null);
    const [r, s, p, w, d] = await Promise.all([
      supabase.from("engine_readiness").select("*").eq("client_id", clientId).maybeSingle(),
      supabase.from("client_engine_settings").select("*").eq("client_id", clientId).maybeSingle(),
      supabase.from("client_engine_platforms").select("platform, posts_per_week, active").eq("client_id", clientId),
      supabase
        .from("client_engine_windows")
        .select("id, weekday, starts_at, ends_at")
        .eq("client_id", clientId)
        .order("weekday"),
      supabase
        .from("publish_due")
        .select("post_id, platform, scheduled_at, asset_title, publication_status, publish_attempts, blocker")
        .eq("client_id", clientId)
        .order("scheduled_at"),
    ]);
    const failed = r.error ?? s.error ?? p.error ?? w.error ?? d.error;
    if (failed) {
      setError(failed.message);
      return;
    }
    setReadiness((r.data as Readiness) ?? null);
    setSettings((s.data as Settings) ?? null);
    setPlatforms((p.data ?? []) as PlatformRow[]);
    setWindows((w.data ?? []) as WindowRow[]);
    setDue((d.data ?? []) as DueRow[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every control here is one RPC and one sentence about what it did.
   *
   * The argument shapes differ per function, so this takes them loosely and
   * the call sites are what tsc checks against the generated types — the
   * alternative is five near-identical handlers.
   */
  async function call(fn: EngineRpc, args: Record<string, unknown>, said: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: rpcError } = await supabase.rpc(
      fn,
      args as never,
    );
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNote(said);
    await refresh();
  }

  if (!clientId) return <p className="text-sm text-muted-foreground">Pick a client first.</p>;

  const running = readiness?.enabled ?? false;
  const canSwitchOn = readiness?.readiness === "Ready, switched off";
  const publishing = settings?.publishing_enabled ?? false;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-card-foreground">
              {running ? "The engine is running for this client" : "The engine is not running"}
            </p>
            <p className="text-sm text-muted-foreground">
              {readiness?.readiness ?? "Not configured"}
              {readiness?.timezone ? ` · posts land on ${readiness.timezone} time` : ""}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || (!running && !canSwitchOn)}
            onClick={() =>
              void call(
                "set_engine_enabled",
                { p_client_id: clientId, p_enabled: !running },
                running ? "The engine is off." : "The engine is on.",
              )
            }
            className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
              running ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {running ? "Switch off" : "Switch on"}
          </button>
        </div>
        {!running && !canSwitchOn ? (
          // Naming the blocker beats a disabled button with no explanation.
          <p className="mt-2 text-xs text-muted-foreground">
            Fix “{readiness?.readiness ?? "Not configured"}” before the engine can be switched on.
          </p>
        ) : null}
      </section>

      {/* The second switch.
          PUBLISH_ENABLED in the runtime is the first, and both must be on.
          Separate from the engine switch on purpose: making content and
          posting it on a client's own accounts are different promises, and
          one button for both means the day somebody turns the engine on for
          a new client, that client's audience hears from it. */}
      <section className="space-y-2 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-card-foreground">
              {publishing
                ? "Approved posts go out on this client's accounts"
                : "Nothing is posted to this client's accounts"}
            </p>
            <p className="text-sm text-muted-foreground">
              {publishing
                ? "An approved post is sent at its planned time. The runtime must also have publishing on."
                : "Approved posts sit on the calendar and wait. Nothing reaches a real account."}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void call(
                "set_publishing_enabled",
                { p_client_id: clientId, p_enabled: !publishing },
                publishing
                  ? "Publishing is off for this client."
                  : "Publishing is on for this client. The runtime has to have it on too.",
              )
            }
            className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
              publishing
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {publishing ? "Stop publishing" : "Start publishing"}
          </button>
        </div>
      </section>

      {/* Why nothing went out, which is the question a board cannot answer.
          publish_due gives one sentence per post; a null blocker means it
          would go out on the next sweep. */}
      {due.length > 0 && (
        <section className="space-y-2 rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-card-foreground">
            Waiting to go out ({due.filter((row) => row.blocker === null).length} of {due.length}{" "}
            ready)
          </h3>
          <ul className="space-y-1">
            {due.map((row) => (
              <li key={row.post_id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-muted-foreground">
                  {new Date(row.scheduled_at).toLocaleString()}
                </span>
                <span className="text-foreground">{row.asset_title ?? "Untitled"}</span>
                {row.platform && <span className="text-muted-foreground">{row.platform}</span>}
                {row.blocker === null ? (
                  <span className="text-brand-strong">Ready to go out.</span>
                ) : (
                  <span className="text-destructive">{row.blocker}</span>
                )}
                {row.publish_attempts
                  ? <span className="text-muted-foreground">
                      {row.publish_attempts} attempt{row.publish_attempts === 1 ? "" : "s"}
                    </span>
                  : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}

      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-card-foreground">Platforms and cadence</h3>
        {POST_PLATFORMS.map((option) => {
          const row = platforms.find((p) => p.platform === option.value);
          return (
            <div key={option.value} className="flex flex-wrap items-center gap-3">
              <span className="w-28 text-sm">{platformLabel(option.value)}</span>
              <input
                type="number"
                min={0}
                max={28}
                aria-label={`${platformLabel(option.value)} posts per week`}
                defaultValue={row?.posts_per_week ?? 0}
                onBlur={(e) =>
                  void call(
                    "set_engine_platform",
                    {
                      p_client_id: clientId,
                      p_platform: option.value,
                      p_posts_per_week: Number(e.target.value),
                      p_active: Number(e.target.value) > 0,
                    },
                    `${platformLabel(option.value)} set to ${e.target.value} a week.`,
                  )
                }
                className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <span className="text-xs text-muted-foreground">a week</span>
            </div>
          );
        })}
      </section>

      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-card-foreground">Posting windows</h3>
        <p className="text-xs text-muted-foreground">
          When a post may land, in the client&rsquo;s own time. The planner never places one outside these.
        </p>
        {windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No windows yet.</p>
        ) : (
          <ul className="space-y-1">
            {windows.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {WEEKDAYS[w.weekday - 1]} {w.starts_at.slice(0, 5)}–{w.ends_at.slice(0, 5)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void call("remove_engine_window", { p_window_id: w.id }, "Window removed.")}
                  className="rounded-md bg-secondary px-2 py-1 text-xs"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <AddWindow
          busy={busy}
          onAdd={(weekday, starts, ends) =>
            void call(
              "add_engine_window",
              { p_client_id: clientId, p_weekday: weekday, p_starts_at: starts, p_ends_at: ends },
              "Window added.",
            )
          }
        />
      </section>

      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-card-foreground">How it decides</h3>
        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-44">Plan ahead</span>
          <input
            type="number"
            min={1}
            max={90}
            aria-label="Plan ahead days"
            defaultValue={settings?.plan_horizon_days ?? 14}
            onBlur={(e) =>
              void call(
                "set_engine_settings",
                { p_client_id: clientId, p_plan_horizon_days: Number(e.target.value) },
                "Horizon saved.",
              )
            }
            className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <span className="text-xs text-muted-foreground">days</span>
        </label>

        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-44">Approval</span>
          <select
            aria-label="Approval mode"
            value={settings?.approval_mode ?? "per_post"}
            onChange={(e) =>
              void call(
                "set_engine_settings",
                { p_client_id: clientId, p_approval_mode: e.target.value },
                "Approval mode saved.",
              )
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="per_post">Each post</option>
            <option value="weekly_batch">A week at a time</option>
          </select>
        </label>

        <label className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-44">Minimum QA score</span>
          <input
            type="number"
            min={0}
            max={100}
            aria-label="Minimum QA score"
            defaultValue={settings?.min_qa_score ?? 70}
            onBlur={(e) =>
              void call(
                "set_engine_settings",
                { p_client_id: clientId, p_min_qa_score: Number(e.target.value) },
                "QA threshold saved.",
              )
            }
            className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </label>

        {(["auto_approve_ideas", "auto_approve_briefs"] as const).map((key) => (
          <label key={key} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              aria-label={key === "auto_approve_ideas" ? "Approve ideas by policy" : "Approve briefs by policy"}
              checked={settings?.[key] ?? false}
              onChange={(e) =>
                void call(
                  "set_engine_settings",
                  { p_client_id: clientId, [`p_${key}`]: e.target.checked },
                  "Saved.",
                )
              }
            />
            <span>{key === "auto_approve_ideas" ? "Approve ideas by policy" : "Approve briefs by policy"}</span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          Policy approvals move an idea or a brief on without a person. Neither replaces the human approval a post
          still needs before it can be scheduled.
        </p>
      </section>
    </div>
  );
}

function AddWindow({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (weekday: number, starts: string, ends: string) => void;
}) {
  const [weekday, setWeekday] = useState(1);
  const [starts, setStarts] = useState("09:00");
  const [ends, setEnds] = useState("11:00");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">Day</span>
        <select
          aria-label="Window day"
          value={weekday}
          onChange={(e) => setWeekday(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        >
          {WEEKDAYS.map((day, i) => (
            <option key={day} value={i + 1}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">From</span>
        <input
          type="time"
          aria-label="Window start"
          value={starts}
          onChange={(e) => setStarts(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
      <label className="text-sm">
        <span className="block text-xs text-muted-foreground">To</span>
        <input
          type="time"
          aria-label="Window end"
          value={ends}
          onChange={(e) => setEnds(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        disabled={busy || starts >= ends}
        onClick={() => onAdd(weekday, starts, ends)}
        className="rounded-md bg-secondary px-3 py-1.5 text-sm disabled:opacity-50"
      >
        Add window
      </button>
    </div>
  );
}
