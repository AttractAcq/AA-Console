import { supabase } from "./supabase";

/**
 * Distribution work still outstanding.
 *
 * Mirrors the `distribution_due` view from migration 123, which is the copy
 * that decides. The states are its states, in the order they demand
 * attention: an orphan can never publish, an overdue post should already
 * have, and the rest is just a calendar.
 */
export type DueState = "orphaned" | "overdue" | "due_today" | "upcoming";

export type DueRow = {
  schedule_id: string;
  asset_id: string | null;
  ref_number: string | null;
  scheduled_for: string;
  channel: string;
  platform: string | null;
  media_type: string;
  asset_title: string | null;
  state: DueState;
  days_late: number;
  human_approved: boolean;
};

/** Worst first. The board should lead with what cannot happen at all. */
const SEVERITY: Record<DueState, number> = {
  orphaned: 0,
  overdue: 1,
  due_today: 2,
  upcoming: 3,
};

export function bySeverity(a: DueRow, b: DueRow): number {
  const order = SEVERITY[a.state] - SEVERITY[b.state];
  return order !== 0 ? order : a.scheduled_for.localeCompare(b.scheduled_for);
}

/** What the Status column should say, instead of a flat "Scheduled". */
export function stateLabel(row: DueRow): string {
  switch (row.state) {
    case "orphaned":
      return "No asset — cannot publish";
    case "overdue":
      return `Overdue by ${row.days_late} day${row.days_late === 1 ? "" : "s"}`;
    case "due_today":
      return "Due today";
    default:
      return "Scheduled";
  }
}

/**
 * The one line worth putting at the top of the board, or null when there is
 * nothing wrong.
 *
 * Deliberately silent when everything is merely upcoming. A banner that is
 * always there is a banner nobody reads, and then the day three posts go
 * quiet for a fortnight it says nothing new.
 */
export function attentionLine(rows: readonly DueRow[]): string | null {
  const orphaned = rows.filter((r) => r.state === "orphaned").length;
  const overdue = rows.filter((r) => r.state === "overdue");
  if (orphaned === 0 && overdue.length === 0) return null;

  const parts: string[] = [];
  if (overdue.length > 0) {
    const worst = Math.max(...overdue.map((r) => r.days_late));
    parts.push(
      `${overdue.length} post${overdue.length === 1 ? "" : "s"} overdue, the oldest by ${worst} day${worst === 1 ? "" : "s"}`,
    );
  }
  if (orphaned > 0) {
    parts.push(
      `${orphaned} scheduled post${orphaned === 1 ? "" : "s"} whose asset was deleted and can never publish`,
    );
  }
  return `${parts.join("; ")}.`;
}

export async function fetchDue(clientId: string, channel: string): Promise<DueRow[]> {
  const { data, error } = await supabase
    .from("distribution_due")
    .select("*")
    .eq("client_id", clientId)
    .eq("channel", channel)
    .order("scheduled_for");
  if (error) throw new Error(error.message);
  return (data ?? []) as DueRow[];
}
