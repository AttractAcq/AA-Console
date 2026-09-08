// What a sales agent is actually doing right now, and how long ago it last
// did it.
//
// Pure, and in its own module rather than exported from the panel, so it can
// be tested and mutated without rendering anything — the same reason the
// runtime's definition rules live in definition.ts.

export type LiveState =
  | { kind: "building"; label: string }
  | { kind: "failed"; label: string }
  | { kind: "unbuilt"; label: string }
  | { kind: "live"; label: string }
  | { kind: "draft"; label: string }
  | { kind: "retired"; label: string };

export const STATE_TONE: Record<LiveState["kind"], string> = {
  building: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  unbuilt: "bg-secondary text-secondary-foreground",
  live: "bg-primary/10 text-brand-strong",
  draft: "bg-secondary text-secondary-foreground",
  retired: "bg-muted text-muted-foreground",
};

/**
 * The one thing a card has to get right.
 *
 * Deliberately not the same as the stored `status`. A status field records an
 * intention; this records what happened, and the gap between them is the whole
 * reason the overview exists.
 *
 * Order matters and is not arbitrary: a job in flight beats everything,
 * because the card is about to change. A failed build outranks the stored
 * status, because an agent marked live whose build never succeeded is not live
 * in any sense a person cares about — showing "Live" there would be the card
 * lying about the only thing it is for.
 */
export function liveStateOf(
  agent: { status: string; built_at: string | null },
  job: { status: string } | undefined,
): LiveState {
  if (job && (job.status === "queued" || job.status === "claimed" || job.status === "running")) {
    return { kind: "building", label: "Building…" };
  }
  if (job && job.status === "failed" && !agent.built_at) {
    return { kind: "failed", label: "Build failed" };
  }
  if (!agent.built_at) return { kind: "unbuilt", label: "Not built yet" };
  if (agent.status === "live") return { kind: "live", label: "Live" };
  if (agent.status === "retired") return { kind: "retired", label: "Retired" };
  return { kind: "draft", label: "Draft — not answering anyone" };
}

/** "3d ago", for the one number that says whether an agent is really working. */
export function sinceLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
