// How an audit's findings are presented, and which of them a person may select.
//
// Pure because the rule that matters — a NEEDS_PERSON finding is never
// selectable — should be checkable without rendering anything. It is enforced
// again in the reviser, which filters them out before the model sees them, and
// again by the check constraint on the column. This layer exists so the button
// is not offered, not to be the thing that stops it.

export type Finding = {
  id: string;
  category: string;
  severity: "low" | "medium" | "high";
  title: string;
  explanation: string;
  suggested_direction: string | null;
  classification: "FIXABLE" | "NEEDS_PERSON";
  status: "open" | "selected" | "applied" | "dismissed" | "stale";
  revision_number: number;
};

export type Revision = {
  id: string;
  revision_number: number;
  source: string;
  summary: string | null;
  created_at: string;
};

export type Grouped = {
  fixable: Finding[];
  needsPerson: Finding[];
  stale: Finding[];
};

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Findings split for display, worst first within each group.
 *
 * Stale findings are separated rather than hidden: they were true of an earlier
 * revision and may still be true, but nothing here has checked.
 */
export function groupFindings(findings: Finding[]): Grouped {
  const live = findings.filter((f) => f.status === "open" || f.status === "selected");
  const bySeverity = (a: Finding, b: Finding) =>
    (SEVERITY_ORDER[a.severity] ?? 1) - (SEVERITY_ORDER[b.severity] ?? 1);

  return {
    fixable: live.filter((f) => f.classification === "FIXABLE").sort(bySeverity),
    needsPerson: live.filter((f) => f.classification === "NEEDS_PERSON").sort(bySeverity),
    stale: findings.filter((f) => f.status === "stale").sort(bySeverity),
  };
}

/** Only a live FIXABLE finding may ever be ticked. */
export function isSelectable(finding: Finding): boolean {
  return (
    finding.classification === "FIXABLE" &&
    (finding.status === "open" || finding.status === "selected")
  );
}

/** Every id a "select all" may legitimately turn on. */
export function selectableIds(findings: Finding[]): string[] {
  return findings.filter(isSelectable).map((f) => f.id);
}

/**
 * Why the reviser cannot be run, or null.
 *
 * Filters the chosen ids against what is actually selectable rather than
 * trusting the caller's set, so a stale tick left over from a previous audit
 * cannot be submitted.
 */
export function reviseBlocker(selected: string[], findings: Finding[]): string | null {
  const allowed = new Set(selectableIds(findings));
  const usable = selected.filter((id) => allowed.has(id));
  if (usable.length === 0) {
    return "Choose at least one fixable finding.";
  }
  return null;
}

/** The chosen ids, narrowed to those that may actually be acted on. */
export function usableSelection(selected: string[], findings: Finding[]): string[] {
  const allowed = new Set(selectableIds(findings));
  return selected.filter((id) => allowed.has(id));
}

/** Plain English for where a revision came from. */
export function revisionSourceLabel(source: string): string {
  switch (source) {
    case "initial_generation":
      return "Original build";
    case "agent_revision":
      return "Agent revision";
    case "manual_edit":
      return "Hand edit";
    case "revert":
      return "Revert";
    default:
      return source;
  }
}

/**
 * The honest one-liner about whether a page is finished.
 *
 * Leads with the gaps, because a page with every craft problem fixed and three
 * missing proof points is not ready, and a fixable-only count would say it was.
 */
export function readinessLine(grouped: Grouped): string {
  const { fixable, needsPerson } = grouped;
  if (fixable.length === 0 && needsPerson.length === 0) {
    return "No outstanding findings.";
  }
  const parts: string[] = [];
  if (needsPerson.length > 0) {
    parts.push(
      `${needsPerson.length} gap${needsPerson.length === 1 ? "" : "s"} needing a real fact from a person`,
    );
  }
  if (fixable.length > 0) {
    parts.push(`${fixable.length} the reviser can fix`);
  }
  return parts.join(", ");
}
