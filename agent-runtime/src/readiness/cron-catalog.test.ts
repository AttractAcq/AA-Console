import { describe, expect, it } from "vitest";
import {
  auditCronCatalog, CRON_REGISTRY_HEAD, EXPECTED_CRON_SCHEDULES,
  type CronCatalogJob,
} from "./cron-catalog.js";

const installed = (): CronCatalogJob[] => Object.entries(EXPECTED_CRON_SCHEDULES).map(([name, schedule]) => ({
  name, schedule, active: true,
}));

describe("released cron schedule catalog", () => {
  it("recognizes the 18 released schedules without claiming run success", () => {
    const audit = auditCronCatalog(CRON_REGISTRY_HEAD, installed());
    expect(audit).toMatchObject({
      state: "matches", expectedCount: 18, observedCount: 18, reason: null,
    });
    expect(audit.rows).toHaveLength(18);
    expect(audit.rows.every((row) => row.issues.length === 0)).toBe(true);
    expect(audit.rows.find((row) => row.name === "engine-tick")?.expectedSchedule).toBe("7 * * * *");
    expect(audit.rows.find((row) => row.name === "profile-update-sweep")?.expectedSchedule).toBe("5,35 * * * *");
  });

  it("distinguishes missing, duplicate, inactive and altered schedules", () => {
    const jobs = installed().filter((job) => job.name !== "engine-tick");
    jobs.find((job) => job.name === "publish-sweep")!.schedule = "* * * * *";
    jobs.find((job) => job.name === "token-health-daily")!.active = false;
    jobs.push({ ...jobs.find((job) => job.name === "outbound-sweep")! });
    const audit = auditCronCatalog(CRON_REGISTRY_HEAD, jobs);
    expect(audit.state).toBe("drift");
    const issue = (name: string) => audit.rows.find((row) => row.name === name)?.issues;
    expect(issue("engine-tick")).toEqual(["missing"]);
    expect(issue("publish-sweep")).toEqual(["schedule_mismatch"]);
    expect(issue("token-health-daily")).toEqual(["inactive"]);
    expect(issue("outbound-sweep")).toEqual(["duplicate"]);
  });

  it("exposes unregistered entries, including anonymous names, as drift", () => {
    const audit = auditCronCatalog(CRON_REGISTRY_HEAD, [
      ...installed(),
      { name: "unnamed#42", schedule: "* * * * *", active: true },
    ]);
    expect(audit.state).toBe("drift");
    expect(audit.rows.at(-1)).toMatchObject({
      name: "unnamed#42", expectedSchedule: null, issues: ["unexpected"],
    });
  });

  it("fails closed for an unreadable catalog or an unreviewed migration head", () => {
    const unreadable = auditCronCatalog(CRON_REGISTRY_HEAD, null);
    expect(unreadable).toMatchObject({ state: "unknown", observedCount: null, rows: [] });
    expect(unreadable.reason).toMatch(/catalog is unavailable/i);
    for (const head of [null, "20261029130000", "20261030170000"]) {
      const changed = auditCronCatalog(head, installed());
      expect(changed).toMatchObject({ state: "unknown", rows: [] });
      expect(changed.reason).toMatch(/repin/i);
    }
  });
});
