import { describe, expect, it } from "vitest";
import { archiveMetricPresentation, CHAIN_STAGES, matchesSearch, publicationEvidence, stageLabel, stageReached } from "./contentChain";
import type { ArchiveMetricCoverage } from "./contentChain";
import type { ArchiveRow } from "./contentChain";

const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  client_id: "c1",
  brief_ref: "AA-0066",
  brief_id: "b1",
  title: "The Four Levers — 8-frame diagnostic carousel",
  media_type: "image",
  content_format: "carousel",
  archived_at: "2026-09-21T06:23:00Z",
  idea_id: "i1",
  idea_title: "The four levers, one frame at a time",
  content_territory: "Offer clarity",
  pillar_name: "Diagnosis",
  frame_count: 8,
  assets: 2,
  approved_assets: 0,
  scheduled: 0,
  published: 0,
  iterations: 1,
  first_published: null,
  ...over,
});

describe("CHAIN_STAGES", () => {
  it("runs in the order a piece of content passes through them", () => {
    expect(CHAIN_STAGES.map((s) => s.id)).toEqual([
      "ideation",
      "brief",
      "asset",
      "distribution",
      "reporting",
      "iteration",
    ]);
  });
});

describe("stageReached", () => {
  // Read off the records rather than a status column: a status says what
  // somebody intended, and the two disagree exactly when it matters.
  it("is reporting once anything published", () => {
    expect(stageReached(row({ assets: 1, scheduled: 1, published: 1 }))).toBe("reporting");
  });

  it("is distribution when scheduled but not out", () => {
    expect(stageReached(row({ assets: 1, scheduled: 1 }))).toBe("distribution");
  });

  it("is asset when built but never scheduled", () => {
    expect(stageReached(row({ assets: 2 }))).toBe("asset");
  });

  it("is brief when nothing was ever built", () => {
    expect(stageReached(row({ assets: 0 }))).toBe("brief");
  });
});

describe("stageLabel", () => {
  it("says how far a piece actually got", () => {
    expect(stageLabel(row({ assets: 0 }))).toBe("Brief only");
    expect(stageLabel(row({ assets: 2 }))).toBe("Built, awaiting approval");
    expect(stageLabel(row({ assets: 2, approved_assets: 1 }))).toBe("Approved, not scheduled");
    expect(stageLabel(row({ assets: 1, approved_assets: 1, scheduled: 1 }))).toBe(
      "Scheduled, not yet out",
    );
  });

  it("counts multiple publications rather than saying published once", () => {
    expect(stageLabel(row({ assets: 1, scheduled: 3, published: 1 }))).toBe("Publication recorded");
    expect(stageLabel(row({ assets: 1, scheduled: 3, published: 3 }))).toBe("Publication recorded ×3");
  });
});

describe("publicationEvidence", () => {
  it("does not present a recorded transition or external reference as provider read-back", () => {
    expect(publicationEvidence({ published_at: null, external_id: null, external_url: null })).toBeNull();
    expect(publicationEvidence({ published_at: "2026-11-18T00:00:00Z", external_id: null, external_url: null }))
      .toContain("without an external reference");
    expect(publicationEvidence({ published_at: "2026-11-18T00:00:00Z", external_id: "post-1", external_url: null }))
      .toContain("provider read-back unverified");
  });
});

const coverage = (over: Partial<ArchiveMetricCoverage> = {}): ArchiveMetricCoverage => ({
  linked_posts: 2, metric_rows: 1, posts_with_metrics: 1, cumulative_rows: 0,
  impression_rows: 1, reach_rows: 0, click_rows: 1, spend_rows: 1,
  currency_count: 1, missing_currency_rows: 0, currency: "ZAR",
  first_metric_date: "2026-11-17", last_metric_date: "2026-11-17",
  last_fetched_at: "2026-11-18T00:00:00Z", ...over,
});

describe("archiveMetricPresentation", () => {
  const totals = { impressions: 0, reach: 0, clicks: 4, spend: 12 };

  it("distinguishes missing values from observed zero and labels partial coverage", () => {
    const result = archiveMetricPresentation(totals, coverage());
    expect(result.impressions).toContain("0 (recorded daily rows");
    expect(result.reach).toBe("unknown (no ingested value)");
    expect(result.spend).toContain("12 (recorded daily rows; coverage unverified) ZAR");
    expect(result.metric_coverage).toContain("1/2 linked posts");
    expect(archiveMetricPresentation(totals, coverage({ metric_rows: 0, impression_rows: 0,
      click_rows: 0, spend_rows: 0 })).impressions).toBe("unknown (no ingested value)");
  });

  it("holds legacy sums when cumulative rows or incompatible currencies are present", () => {
    expect(archiveMetricPresentation(totals, coverage({ cumulative_rows: 1 })).impressions)
      .toContain("unknown (legacy sum includes cumulative snapshots)");
    expect(archiveMetricPresentation(totals, coverage({ currency_count: 2 })).spend)
      .toBe("unknown (spend currency missing or mixed)");
    expect(archiveMetricPresentation(totals, null).impressions).toBe("unknown");
  });
});

describe("matchesSearch", () => {
  // The archive is keyed on a reference, so searching by one has to work.
  it("matches the reference", () => {
    expect(matchesSearch(row(), "AA-0066")).toBe(true);
    expect(matchesSearch(row(), "aa-0066")).toBe(true);
    expect(matchesSearch(row(), "0066")).toBe(true);
  });

  it("matches the title, the idea behind it, the territory and the pillar", () => {
    expect(matchesSearch(row(), "four levers")).toBe(true);
    expect(matchesSearch(row(), "one frame at a time")).toBe(true);
    expect(matchesSearch(row(), "offer clarity")).toBe(true);
    expect(matchesSearch(row(), "diagnosis")).toBe(true);
  });

  it("does not match something absent", () => {
    expect(matchesSearch(row(), "whatsapp")).toBe(false);
  });

  it("shows everything for an empty or blank search", () => {
    expect(matchesSearch(row(), "")).toBe(true);
    expect(matchesSearch(row(), "   ")).toBe(true);
  });

  it("survives a row with nothing but a reference", () => {
    const bare = row({ title: "", idea_title: null, content_territory: null, pillar_name: null });
    expect(matchesSearch(bare, "AA-0066")).toBe(true);
    expect(matchesSearch(bare, "anything")).toBe(false);
  });
});
