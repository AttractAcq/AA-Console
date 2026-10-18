/**
 * The engine's approval queue, as a person reads it.
 *
 * M4 put three functions in the database — approve_slot, reject_slot,
 * regenerate_slot — and the one human commit the whole engine stops at.
 * Nothing called any of them, which for anybody without SQL access is the
 * same as the engine having no way to finish.
 *
 * The shaping here is pure so it can be tested without a browser: Postgres
 * interval parsing, the waiting and due labels, and which of the three acts
 * each slot is at.
 */

export type Severity = "blocker" | "warning" | "note";

export interface Finding {
  area?: string | null;
  severity?: string | null;
  detail?: string | null;
}

/** One row of approval_inbox, as PostgREST serialises it. */
export interface InboxRow {
  slot_id: string;
  client_id: string;
  client_name: string | null;
  platform: string;
  format: string | null;
  scheduled_at: string;
  qa_score: number | null;
  qa_findings: Finding[] | null;
  finding_count: number | null;
  warnings: number | null;
  attempts: number | null;
  cost_usd: number | string | null;
  asset_id: string | null;
  asset_title: string | null;
  /** Set once a person has signed the asset off. Null for everything in this queue. */
  human_approved_at: string | null;
  pillar_name: string | null;
  idea_score: number | string | null;
  idea_reasons: unknown;
  /** Postgres intervals, as text: "03:14:00", "2 days 03:00:00", "-00:40:00". */
  waiting_for: string | null;
  goes_out_in: string | null;
  overdue: boolean | null;
}

const UNIT_SECONDS: Record<string, number> = {
  // Only the units Postgres actually prints for an interval of this kind.
  // mon and year are approximations by definition — a month has no fixed
  // length — and they only appear here for a slot nobody has looked at for
  // a very long time, where "about a month" is the honest answer anyway.
  year: 365 * 86400,
  mon: 30 * 86400,
  day: 86400,
  week: 7 * 86400,
  hour: 3600,
  min: 60,
  sec: 1,
};

/**
 * A Postgres interval in seconds, or null if it is not one.
 *
 * Parsed rather than trusted to a Date: PostgREST sends intervals as the
 * text Postgres prints, which is "2 days 03:00:00" and not anything
 * `new Date()` understands. Reading one with Date.parse gives NaN, and NaN
 * formatted into a label reads as a real answer.
 *
 * Negative intervals matter: goes_out_in is negative for a post whose time
 * has gone, which is the case a person most needs to see. Postgres puts the
 * sign on each part it prints, so "-1 days -03:00:00" is -27 hours and not
 * -21.
 */
export function parseInterval(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  let total = 0;
  let matched = false;

  // "2 days", "1 mon", "-1 days"
  for (const match of text.matchAll(/(-?\d+)\s+(year|mon|week|day|hour|min|sec)s?\b/g)) {
    const unit = UNIT_SECONDS[match[2]!];
    if (unit === undefined) continue;
    total += Number(match[1]) * unit;
    matched = true;
  }

  // The clock part: "03:14:00", "-00:40:00", "00:01:30.5"
  const clock = text.match(/(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (clock) {
    const sign = clock[1] === "-" ? -1 : 1;
    total +=
      sign * (Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]));
    matched = true;
  }

  return matched ? total : null;
}

/**
 * How long, in words, rounded down to the unit a person would say.
 *
 * Rounded down on purpose: "3 hours" for anything from three to four is how
 * somebody describes a wait, and rounding up would report a slot as having
 * waited longer than it has.
 */
export function relativeLabel(seconds: number | null): string {
  if (seconds === null) return "unknown";
  const abs = Math.abs(seconds);
  if (abs < 60) return "under a minute";
  if (abs < 3600) {
    const minutes = Math.floor(abs / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (abs < 86400) {
    const hours = Math.floor(abs / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(abs / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export type Urgency = "overdue" | "soon" | "later";

export interface InboxCard {
  slotId: string;
  clientId: string;
  clientName: string;
  assetId: string | null;
  assetTitle: string;
  platform: string;
  format: string | null;
  pillarName: string | null;
  scheduledAt: string;
  /** "waited 3 hours" */
  waited: string;
  /** "goes out in 2 hours" or "was due 40 minutes ago" */
  due: string;
  urgency: Urgency;
  qaScore: number | null;
  blockers: Finding[];
  warnings: Finding[];
  notes: Finding[];
  reasons: string[];
  attempts: number;
  costUsd: number;
}

function severityOf(finding: Finding): Severity {
  const raw = (finding.severity ?? "").toLowerCase();
  if (raw === "blocker") return "blocker";
  if (raw === "warning") return "warning";
  return "note";
}

/** idea_reasons is jsonb and has been both an array of strings and an object. */
export function readReasons(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`);
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/** How soon a slot needs a person, given when it was meant to go out. */
export function urgencyOf(row: Pick<InboxRow, "overdue" | "goes_out_in">): Urgency {
  if (row.overdue) return "overdue";
  const seconds = parseInterval(row.goes_out_in);
  // A null interval is not an emergency and not a reassurance. Treating it
  // as "later" rather than "soon" is the quiet choice; saying nothing is
  // wrong is worse than saying nothing is urgent, so it sits in the middle.
  if (seconds !== null && seconds <= 0) return "overdue";
  if (seconds !== null && seconds < 24 * 3600) return "soon";
  return "later";
}

export function inboxCard(row: InboxRow): InboxCard {
  const findings = Array.isArray(row.qa_findings) ? row.qa_findings : [];
  const waitedSeconds = parseInterval(row.waiting_for);
  const dueSeconds = parseInterval(row.goes_out_in);
  const urgency = urgencyOf(row);

  return {
    slotId: row.slot_id,
    clientId: row.client_id,
    clientName: row.client_name?.trim() || "This client",
    assetId: row.asset_id,
    assetTitle: row.asset_title?.trim() || "Untitled",
    platform: row.platform,
    format: row.format,
    pillarName: row.pillar_name?.trim() || null,
    scheduledAt: row.scheduled_at,
    waited: waitedSeconds === null ? "Waiting" : `Waiting ${relativeLabel(waitedSeconds)}`,
    due:
      dueSeconds === null
        ? "No time on it"
        : dueSeconds < 0 || urgency === "overdue"
          ? `Was due ${relativeLabel(dueSeconds)} ago`
          : `Goes out in ${relativeLabel(dueSeconds)}`,
    urgency,
    qaScore: row.qa_score,
    blockers: findings.filter((f) => severityOf(f) === "blocker"),
    warnings: findings.filter((f) => severityOf(f) === "warning"),
    notes: findings.filter((f) => severityOf(f) === "note"),
    reasons: readReasons(row.idea_reasons),
    attempts: row.attempts ?? 0,
    costUsd: Number(row.cost_usd ?? 0),
  };
}

/**
 * Overdue first, then by how soon it goes out, then by how long it has
 * waited. The order a person should work the queue in, rather than the order
 * the rows arrived.
 */
export function inboxOrder(cards: InboxCard[]): InboxCard[] {
  const rank: Record<Urgency, number> = { overdue: 0, soon: 1, later: 2 };
  return [...cards].sort(
    (a, b) =>
      rank[a.urgency] - rank[b.urgency] ||
      new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
  );
}
