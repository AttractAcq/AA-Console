/**
 * The pg_cron schedule contract at the last released migration. This checks
 * catalog configuration only. A matching row says nothing about whether the
 * job ran, succeeded, found work, or respected an external-action gate.
 */
export const CRON_REGISTRY_HEAD = "20261030160000";

export const EXPECTED_CRON_SCHEDULES: Readonly<Record<string, string>> = Object.freeze({
  "metrics-ingest-daily": "15 3 * * *",
  "engine-tick": "7 * * * *",
  "token-health-daily": "45 2 * * *",
  "publish-sweep": "*/10 * * * *",
  "reap-stale-publish-claims": "20 * * * *",
  "resume-paused-jobs": "10 * * * *",
  "campaign-action-sweep": "*/10 * * * *",
  "reap-stale-campaign-actions": "25 * * * *",
  "proof-placement-sweep": "*/10 * * * *",
  "reap-stale-proof-placements": "35 * * * *",
  "sweep-expired-proof-placements": "15 3 * * *",
  "lead-magnet-sweep": "*/2 * * * *",
  "reap-stale-lead-magnet-deliveries": "45 * * * *",
  "outbound-sweep": "*/5 * * * *",
  "reap-stale-outbound-claims": "55 * * * *",
  "nurture-sequence-sweep": "*/15 * * * *",
  "profile-update-sweep": "5,35 * * * *",
  "prune-runtime-heartbeats": "*/15 * * * *",
});

export type CronCatalogJob = { name: string; schedule: string; active: boolean };
export type CronCatalogIssue = "missing" | "inactive" | "schedule_mismatch" | "duplicate" | "unexpected";
export type CronCatalogAuditRow = {
  name: string;
  expectedSchedule: string | null;
  observed: { schedule: string; active: boolean }[];
  issues: CronCatalogIssue[];
};
export type CronCatalogAudit = {
  state: "matches" | "drift" | "unknown";
  registryHead: string;
  observedHead: string | null;
  expectedCount: number;
  observedCount: number | null;
  reason: string | null;
  rows: CronCatalogAuditRow[];
};

export function auditCronCatalog(
  migrationHead: string | null,
  jobs: CronCatalogJob[] | null,
): CronCatalogAudit {
  const base = {
    registryHead: CRON_REGISTRY_HEAD,
    observedHead: migrationHead,
    expectedCount: Object.keys(EXPECTED_CRON_SCHEDULES).length,
    observedCount: jobs?.length ?? null,
  };

  if (jobs === null) {
    return {
      ...base, state: "unknown", rows: [],
      reason: "The cron catalog is unavailable; schedule conformance cannot be checked.",
    };
  }
  // A later migration may deliberately change schedules. A prior/unknown
  // migration may not have installed them. Never treat either as conformant.
  if (migrationHead !== CRON_REGISTRY_HEAD) {
    return {
      ...base, state: "unknown", rows: [],
      reason: "The observed migration head differs from the pinned cron registry; review and repin the expected schedules before comparing.",
    };
  }

  const byName = new Map<string, CronCatalogJob[]>();
  for (const job of jobs) {
    const group = byName.get(job.name) ?? [];
    group.push(job);
    byName.set(job.name, group);
  }

  const rows: CronCatalogAuditRow[] = Object.entries(EXPECTED_CRON_SCHEDULES).map(([name, expectedSchedule]) => {
    const observed = byName.get(name) ?? [];
    const issues: CronCatalogIssue[] = [];
    if (observed.length === 0) issues.push("missing");
    if (observed.length > 1) issues.push("duplicate");
    if (observed.some((job) => !job.active)) issues.push("inactive");
    if (observed.some((job) => job.schedule !== expectedSchedule)) issues.push("schedule_mismatch");
    return {
      name, expectedSchedule,
      observed: observed.map(({ schedule, active }) => ({ schedule, active })),
      issues,
    };
  });

  for (const [name, observed] of [...byName].sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.hasOwn(EXPECTED_CRON_SCHEDULES, name)) continue;
    rows.push({
      name, expectedSchedule: null,
      observed: observed.map(({ schedule, active }) => ({ schedule, active })),
      issues: observed.length > 1 ? ["unexpected", "duplicate"] : ["unexpected"],
    });
  }

  const driftCount = rows.filter((row) => row.issues.length > 0).length;
  return {
    ...base,
    state: driftCount === 0 ? "matches" : "drift",
    reason: driftCount === 0 ? null : `${driftCount} cron catalog ${driftCount === 1 ? "entry has" : "entries have"} a schedule anomaly.`,
    rows,
  };
}
