import { describe, expect, it } from "vitest";
import { POOL_DAYS, isSpendTemplate, poolWarning, type CampaignRow, type FeederRow } from "./sequencing.js";
import { templateFor } from "./templates.js";

const NOW = new Date("2026-09-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const campaign = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: "c1",
  template: "R1",
  feedsFromCampaignId: "p4",
  ...over,
});

const feeder = (over: Partial<FeederRow> = {}): FeederRow => ({
  id: "p4",
  template: "P4",
  builtAt: daysAgo(30),
  ...over,
});

describe("isSpendTemplate", () => {
  it("knows which templates convert a pool rather than build one", () => {
    expect(isSpendTemplate(templateFor("R1"))).toBe(true);
    expect(isSpendTemplate(templateFor("C1"))).toBe(true);
    expect(isSpendTemplate(templateFor("P1"))).toBe(false);
    expect(isSpendTemplate(templateFor("X2"))).toBe(false);
    expect(isSpendTemplate(null)).toBe(false);
  });
});

describe("a campaign with a healthy pool", () => {
  it("says nothing", () => {
    expect(poolWarning(campaign(), feeder(), NOW)).toBeNull();
  });

  it("says nothing the day the pool comes of age", () => {
    expect(poolWarning(campaign(), feeder({ builtAt: daysAgo(POOL_DAYS) }), NOW)).toBeNull();
  });
});

describe("a campaign that needs no pool", () => {
  it("says nothing about a build template", () => {
    expect(poolWarning(campaign({ template: "P1", feedsFromCampaignId: null }), null, NOW)).toBeNull();
  });

  it("says nothing about a campaign with no template at all", () => {
    expect(poolWarning(campaign({ template: null, feedsFromCampaignId: null }), null, NOW)).toBeNull();
  });

  it("says nothing about a template it does not recognise", () => {
    expect(poolWarning(campaign({ template: "P9", feedsFromCampaignId: null }), null, NOW)).toBeNull();
  });
});

describe("a spend campaign with a problem", () => {
  it("warns when no feeder is named, and repeats the prerequisite", () => {
    const warning = poolWarning(campaign({ feedsFromCampaignId: null }), null, NOW);
    expect(warning).toContain("R1 spends an audience another campaign builds");
    expect(warning).toContain("P1 or P4 running 14 days");
  });

  it("warns when the feeder has gone", () => {
    expect(poolWarning(campaign(), null, NOW)).toContain("no longer there");
  });

  it("warns when the feeder spends rather than builds", () => {
    const warning = poolWarning(campaign(), feeder({ template: "R2" }), NOW);
    expect(warning).toContain("R2 spends a pool rather than building one");
    expect(warning).toContain("cannot fill R1");
  });

  it("warns when the feeder was never built", () => {
    expect(poolWarning(campaign(), feeder({ builtAt: null }), NOW)).toContain("not been built yet");
  });

  it("counts the days remaining while the pool is still filling", () => {
    const warning = poolWarning(campaign(), feeder({ builtAt: daysAgo(3) }), NOW);
    expect(warning).toContain("running 3 days");
    expect(warning).toContain("11 to go");
  });

  it("says day, not days, on the first one", () => {
    expect(poolWarning(campaign(), feeder({ builtAt: daysAgo(1) }), NOW)).toContain("running 1 day.");
  });

  // Falling through would return null, which says the pool is fine. We have
  // no idea whether it is.
  it("says so when the build date cannot be read, rather than implying the pool is fine", () => {
    expect(poolWarning(campaign(), feeder({ builtAt: "not a date" }), NOW)).toContain(
      "unreadable build date",
    );
  });
});
