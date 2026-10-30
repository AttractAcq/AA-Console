import { useCallback, useEffect, useState } from "react";

import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type CoverageRow = Database["public"]["Views"]["approval_class_coverage_v6"]["Row"];
type CoverageSummary = Database["public"]["Views"]["approval_coverage_summary_v6"]["Row"];
type CoverageState = "missing" | "blocked" | "verified";
type OverallState = "missing" | "blocked" | "operational";

const EXPECTED_CLASSES = 34;
const INVENTORY_VERSION = "b008-34-classes";
const STATES = new Set<CoverageState>(["missing", "blocked", "verified"]);

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function expectedOverall(row: CoverageRow): OverallState {
  if (row.source_state === "verified" && row.decision_state === "verified"
    && row.executor_state === "verified") return "operational";
  if (row.source_state === "missing" && row.decision_state === "missing") return "missing";
  return "blocked";
}

/** The view is a recorded implementation inventory, never a live provider or permission probe. */
function reconcileApprovalCoverage(rows: CoverageRow[] | null, summary: CoverageSummary | null) {
  if (!Array.isArray(rows) || !summary || summary.inventory_version !== INVENTORY_VERSION
    || summary.expected_classes !== EXPECTED_CLASSES
    || !validCount(summary.inventoried_classes)
    || !validCount(summary.operational_classes)
    || !validCount(summary.blocked_classes)
    || !validCount(summary.missing_classes)
    || typeof summary.fully_operational !== "boolean"
    || rows.length !== EXPECTED_CLASSES
    || summary.inventoried_classes !== rows.length) {
    throw new Error("The coverage inventory is incomplete or inconsistent.");
  }

  const seen = new Set<number>();
  const seenKeys = new Set<string>();
  let operational = 0;
  let blocked = 0;
  let missing = 0;
  for (const row of rows) {
    if (!validCount(row.class_id) || row.class_id < 1 || row.class_id > EXPECTED_CLASSES
      || seen.has(row.class_id) || !validCount(row.revision) || row.revision < 1
      || !requiredText(row.class_key) || !requiredText(row.title)
      || seenKeys.has(row.class_key)
      || !STATES.has(row.source_state as CoverageState)
      || !STATES.has(row.decision_state as CoverageState)
      || !STATES.has(row.executor_state as CoverageState)
      || !requiredText(row.recorded_at)
      || !Number.isFinite(Date.parse(row.recorded_at))
      || (row.source_state === "verified" && !requiredText(row.source_evidence))
      || (row.decision_state === "verified" && !requiredText(row.decision_evidence))
      || (row.executor_state === "verified" && !requiredText(row.executor_evidence))
      || row.overall_status !== expectedOverall(row)) {
      throw new Error("The coverage inventory contains an invalid class record.");
    }
    seen.add(row.class_id);
    seenKeys.add(row.class_key);
    if (row.overall_status === "operational") operational += 1;
    else if (row.overall_status === "blocked") blocked += 1;
    else missing += 1;
  }
  if (operational !== summary.operational_classes || blocked !== summary.blocked_classes
    || missing !== summary.missing_classes
    || summary.fully_operational !== (operational === EXPECTED_CLASSES)) {
    throw new Error("The coverage totals do not match the class records.");
  }
  return { rows: [...rows].sort((a, b) => a.class_id! - b.class_id!),
    operational, blocked, missing };
}

function evidence(state: string | null, detail: string | null) {
  return <>
    <span className="font-medium capitalize">{state ?? "Unknown"}</span>
    {detail && <span className="block break-words text-xs text-muted-foreground">{detail}</span>}
  </>;
}

export function ApprovalCoveragePanel() {
  const [coverage, setCoverage] = useState<ReturnType<typeof reconcileApprovalCoverage> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [classes, summary] = await Promise.all([
        supabase.from("approval_class_coverage_v6")
          .select("class_id,revision,class_key,title,source_state,source_evidence,decision_state,decision_evidence,executor_state,executor_evidence,blocker,recorded_at,overall_status")
          .order("class_id", { ascending: true }),
        supabase.from("approval_coverage_summary_v6")
          .select("inventory_version,expected_classes,inventoried_classes,operational_classes,blocked_classes,missing_classes,fully_operational")
          .maybeSingle(),
      ]);
      if (classes.error || summary.error) throw new Error("Coverage read failed.");
      setCoverage(reconcileApprovalCoverage(classes.data, summary.data));
    } catch {
      setCoverage(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; };
  }, [refresh]);

  return <section aria-labelledby="approval-coverage-title" className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="approval-coverage-title" className="text-base font-semibold">Approval class coverage</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Recorded implementation evidence for the 34 planned decision classes. These records do not verify live accounts, current permissions, provider effects or a real AAL2 pilot.
        </p>
      </div>
      <button type="button" onClick={() => void refresh()} disabled={loading}
        className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50">
        Refresh coverage
      </button>
    </div>

    {loading && <p role="status" className="mt-3 text-sm text-muted-foreground">Checking recorded coverage…</p>}
    {error && !loading && <p role="alert" className="mt-3 text-sm text-destructive">
      Coverage is unavailable or inconsistent. No completion count can be shown. Retry the read before assessing readiness.
    </p>}
    {coverage && !loading && <>
      <p className="mt-3 text-sm" role="status">
        Recorded coverage: {coverage.operational} of {EXPECTED_CLASSES} classes marked operational;
        {` ${coverage.blocked} blocked, ${coverage.missing} missing.`}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Inspect all 34 class records</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-left text-xs">
            <thead><tr className="border-b border-border">
              <th scope="col" className="p-2">Class</th>
              <th scope="col" className="p-2">Source</th>
              <th scope="col" className="p-2">Decision</th>
              <th scope="col" className="p-2">Executor</th>
              <th scope="col" className="p-2">Blocker and record</th>
            </tr></thead>
            <tbody>{coverage.rows.map((row) => <tr key={row.class_id} className="border-b border-border align-top">
              <th scope="row" className="p-2 font-medium">{String(row.class_id).padStart(2, "0")} · {row.title}
                <span className="block font-mono text-[11px] text-muted-foreground">{row.class_key}</span>
                <span className="block capitalize">{row.overall_status}</span>
              </th>
              <td className="p-2">{evidence(row.source_state, row.source_evidence)}</td>
              <td className="p-2">{evidence(row.decision_state, row.decision_evidence)}</td>
              <td className="p-2">{evidence(row.executor_state, row.executor_evidence)}</td>
              <td className="p-2">{row.blocker || "No blocker recorded."}
                <span className="mt-1 block text-muted-foreground">Revision {row.revision} · recorded {row.recorded_at}</span>
              </td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}
  </section>;
}
