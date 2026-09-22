import { describe, expect, it } from "vitest";
import { attentionLine, bySeverity, stateLabel } from "./distributionDue";
import type { DueRow } from "./distributionDue";

const row = (over: Partial<DueRow> = {}): DueRow => ({
  schedule_id: "s1",
  asset_id: "a1",
  ref_number: "AA-0067",
  scheduled_for: "2026-09-09",
  channel: "organic",
  platform: "instagram",
  media_type: "image",
  asset_title: "The Four Levers",
  state: "overdue",
  days_late: 13,
  human_approved: true,
  ...over,
});

describe("stateLabel", () => {
  // The board said "Scheduled" for a post 13 days past its date. That is the
  // whole bug: an unpublished post had no third thing to be.
  it("says how late an overdue post is, not that it is scheduled", () => {
    expect(stateLabel(row({ state: "overdue", days_late: 13 }))).toBe("Overdue by 13 days");
    expect(stateLabel(row({ state: "overdue", days_late: 1 }))).toBe("Overdue by 1 day");
  });

  it("names an orphan as unpublishable rather than late", () => {
    expect(stateLabel(row({ state: "orphaned", days_late: 6 }))).toBe("No asset — cannot publish");
  });

  it("distinguishes due today from merely scheduled", () => {
    expect(stateLabel(row({ state: "due_today", days_late: 0 }))).toBe("Due today");
    expect(stateLabel(row({ state: "upcoming", days_late: 0 }))).toBe("Scheduled");
  });
});

describe("bySeverity", () => {
  // An orphan can never publish no matter how long anyone waits, so it
  // outranks something merely late.
  it("puts what cannot happen above what has not happened", () => {
    const sorted = [
      row({ state: "upcoming", scheduled_for: "2026-09-23" }),
      row({ state: "overdue", scheduled_for: "2026-09-09" }),
      row({ state: "orphaned", scheduled_for: "2026-09-16" }),
      row({ state: "due_today", scheduled_for: "2026-09-22" }),
    ].sort(bySeverity);
    expect(sorted.map((r) => r.state)).toEqual(["orphaned", "overdue", "due_today", "upcoming"]);
  });

  it("breaks ties by date, oldest first", () => {
    const sorted = [
      row({ state: "overdue", scheduled_for: "2026-09-18" }),
      row({ state: "overdue", scheduled_for: "2026-09-09" }),
    ].sort(bySeverity);
    expect(sorted.map((r) => r.scheduled_for)).toEqual(["2026-09-09", "2026-09-18"]);
  });
});

describe("attentionLine", () => {
  // A banner that is always there is a banner nobody reads.
  it("says nothing when everything is merely upcoming", () => {
    expect(attentionLine([row({ state: "upcoming" }), row({ state: "due_today" })])).toBeNull();
    expect(attentionLine([])).toBeNull();
  });

  it("leads with the count overdue and how old the worst is", () => {
    const line = attentionLine([
      row({ state: "overdue", days_late: 13 }),
      row({ state: "overdue", days_late: 4 }),
    ]);
    expect(line).toBe("2 posts overdue, the oldest by 13 days.");
  });

  it("names orphans separately, because they need a different fix", () => {
    const line = attentionLine([row({ state: "orphaned", days_late: 6 })]);
    expect(line).toBe("1 scheduled post whose asset was deleted and can never publish.");
  });

  it("reports both when both are present", () => {
    const line = attentionLine([
      row({ state: "overdue", days_late: 13 }),
      row({ state: "orphaned", days_late: 6 }),
      row({ state: "upcoming", days_late: 0 }),
    ]);
    expect(line).toContain("1 post overdue, the oldest by 13 days");
    expect(line).toContain("1 scheduled post whose asset was deleted");
  });

  it("uses singular where it should", () => {
    expect(attentionLine([row({ state: "overdue", days_late: 1 })])).toBe(
      "1 post overdue, the oldest by 1 day.",
    );
  });
});
