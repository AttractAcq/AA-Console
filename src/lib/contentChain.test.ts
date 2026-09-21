import { describe, expect, it } from "vitest";
import { CHAIN_STAGES, matchesSearch, stageLabel, stageReached } from "./contentChain";
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
    expect(stageLabel(row({ assets: 1, scheduled: 3, published: 1 }))).toBe("Published");
    expect(stageLabel(row({ assets: 1, scheduled: 3, published: 3 }))).toBe("Published ×3");
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
