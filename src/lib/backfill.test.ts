import { describe, expect, it } from "vitest";

import {
  PRESETS,
  coverageSentence,
  monthsAgo,
  trailing,
  windowDays,
  windowProblem,
  type CoverageRow,
} from "./backfill";

const JAN_15 = new Date("2027-01-15T11:00:00Z");

describe("the window a preset asks for", () => {
  it("ends yesterday, not today", () => {
    // Today's figures are hours old at best and the daily sync re-pulls
    // them anyway, so including today spends a request on a number that is
    // about to change.
    expect(trailing(7, JAN_15)).toEqual({ since: "2027-01-08", until: "2027-01-14" });
  });

  it("counts both ends, as the database does", () => {
    expect(windowDays(trailing(7, JAN_15))).toBe(7);
    expect(windowDays(trailing(30, JAN_15))).toBe(30);
    expect(windowDays(trailing(1, JAN_15))).toBe(1);
  });

  it("crosses a year without arithmetic of its own", () => {
    expect(trailing(30, new Date("2027-01-05T11:00:00Z"))).toEqual({
      since: "2026-12-06",
      until: "2027-01-04",
    });
  });

  it("takes a calendar month whole", () => {
    expect(monthsAgo(1, JAN_15)).toEqual({ since: "2026-12-01", until: "2026-12-31" });
  });

  it("gets February's length right, including a leap year", () => {
    expect(monthsAgo(1, new Date("2027-03-10T00:00:00Z"))).toEqual({
      since: "2027-02-01",
      until: "2027-02-28",
    });
    expect(monthsAgo(1, new Date("2028-03-10T00:00:00Z"))).toEqual({
      since: "2028-02-01",
      until: "2028-02-29",
    });
  });

  it("offers windows that are all within any sane cap", () => {
    for (const preset of PRESETS) {
      expect(windowDays(preset.window(JAN_15))).toBeLessThanOrEqual(90);
    }
  });
});

describe("what is wrong with a window", () => {
  it("accepts an ordinary one", () => {
    expect(windowProblem({ since: "2027-01-01", until: "2027-01-10" }, 400, JAN_15)).toBeNull();
  });

  it("says when the dates are the wrong way round", () => {
    expect(windowProblem({ since: "2027-01-10", until: "2027-01-01" }, 400, JAN_15)).toMatch(
      /starts after it ends/,
    );
  });

  it("says when it ends in the future", () => {
    expect(windowProblem({ since: "2027-01-01", until: "2027-02-01" }, 400, JAN_15)).toMatch(
      /ends in the future/,
    );
  });

  it("allows today as the last day", () => {
    // Not offered by a preset, but a person typing it is not wrong.
    expect(windowProblem({ since: "2027-01-01", until: "2027-01-15" }, 400, JAN_15)).toBeNull();
  });

  it("asks for both ends", () => {
    expect(windowProblem({ since: "", until: "2027-01-10" }, 400, JAN_15)).toMatch(/both ends/);
    expect(windowProblem({ since: "2027-01-01", until: "" }, 400, JAN_15)).toMatch(/both ends/);
  });

  it("uses the cap the database gave it, not one of its own", () => {
    // Migration 156 was one rule written in two places. A cap the UI
    // believes is 400 while the database enforces 90 is the same mistake.
    // One window, two caps, two different answers — and the message names
    // the number the database gave rather than a constant in this file.
    const wide = { since: "2025-08-01", until: "2027-01-01" };
    expect(windowDays(wide)).toBeGreaterThan(400);
    expect(windowProblem(wide, 400, JAN_15)).toMatch(/at most 400/);
    expect(windowProblem(wide, 90, JAN_15)).toMatch(/at most 90/);
    // And a window inside the larger cap is only refused by the smaller.
    const year = { since: "2026-01-01", until: "2027-01-01" };
    expect(windowProblem(year, 400, JAN_15)).toBeNull();
    expect(windowProblem(year, 90, JAN_15)).toMatch(/at most 90/);
  });

  it("checks no length at all before the cap has been read", () => {
    // Better to let the server refuse it than to invent a limit here.
    expect(windowProblem({ since: "2020-01-01", until: "2027-01-01" }, null, JAN_15)).toBeNull();
  });

  it("allows exactly the cap", () => {
    expect(windowProblem(trailing(90, JAN_15), 90, JAN_15)).toBeNull();
    expect(windowProblem(trailing(91, JAN_15), 90, JAN_15)).toMatch(/at most 90/);
  });
});

describe("what is already on file", () => {
  const row = (over: Partial<CoverageRow> = {}): CoverageRow => ({
    surface: "paid",
    first_day: "2026-09-01",
    last_day: "2026-09-30",
    days_with_data: 30,
    days_missing_inside: 0,
    last_fetched_at: "2026-10-01T03:15:00Z",
    ...over,
  });

  it("says a complete span has no gaps", () => {
    expect(coverageSentence(row(), "paid")).toBe(
      "30 days from 2026-09-01 to 2026-09-30, with no gaps.",
    );
  });

  it("distinguishes a failed pull from a young account", () => {
    // A gap inside the span and a short span want different actions, so
    // they are said differently rather than both being "some days missing".
    const text = coverageSentence(row({ days_with_data: 27, days_missing_inside: 3 }), "paid");
    expect(text).toMatch(/3 days missing inside that span/);
    expect(text).toMatch(/a pull that failed rather than a young account/);
  });

  it("says plainly when there is nothing at all", () => {
    expect(coverageSentence(undefined, "organic")).toMatch(/No organic metrics on file/);
    expect(coverageSentence(row({ first_day: null, last_day: null }), "paid")).toMatch(
      /No paid metrics on file/,
    );
  });

  it("gets the singular right", () => {
    expect(coverageSentence(row({ first_day: "2026-09-01", last_day: "2026-09-01", days_with_data: 1 }), "paid")).toBe(
      "1 day from 2026-09-01 to 2026-09-01, with no gaps.",
    );
  });
});
