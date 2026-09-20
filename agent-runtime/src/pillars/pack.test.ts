import { describe, expect, it } from "vitest";
import { pillarContextPack } from "./pack.js";
import type { UpstreamRecord } from "../agents/shared.js";

const rec = (domain: string, item_key: string): UpstreamRecord =>
  ({ domain, item_key, title: item_key, body: "x" }) as UpstreamRecord;

describe("pillarContextPack", () => {
  it("keeps brand strategy whole, because it is already the compression layer", () => {
    const records = [
      rec("brand_strategy", "cross-os-synthesis"),
      rec("brand_strategy", "strategic-recommendations"),
      rec("brand_strategy", "recommended-portfolio"),
    ];
    expect(pillarContextPack(records)).toHaveLength(3);
  });

  it("keeps the ICP sections that say what the buyer needs to hear", () => {
    const kept = pillarContextPack([
      rec("icp", "objections"),
      rec("icp", "risk-and-fears"),
      rec("icp", "language-patterns"),
    ]);
    expect(kept).toHaveLength(3);
  });

  // 22 ICP records for one client. A pillar drawn from everything is a
  // pillar about nothing, and it timed out before it answered.
  it("drops the ICP sections that do not bear on what to say", () => {
    const kept = pillarContextPack([
      rec("icp", "question-universe"),
      rec("icp", "buying-committee"),
      rec("icp", "firmographics"),
      rec("icp", "objections"),
    ]);
    expect(kept.map((r) => r.item_key)).toEqual(["objections"]);
  });

  it("keeps only what the offer is promising, not the whole offer strategy", () => {
    const kept = pillarContextPack([
      rec("offer_strategy", "dream-outcome"),
      rec("offer_strategy", "guarantee"),
      rec("offer_strategy", "pricing-ladder"),
      rec("offer_strategy", "delivery-model"),
    ]);
    expect(kept.map((r) => r.item_key)).toEqual(["dream-outcome", "guarantee"]);
  });

  it("drops a domain it was never meant to read", () => {
    expect(pillarContextPack([rec("competitor", "anything"), rec("market", "anything")])).toEqual([]);
  });

  it("cuts a real client's corpus by more than half", () => {
    // Harbour Dental on the day this was written: 36 records across the three
    // domains, of which 10 survive the pack.
    const records = [
      ...Array.from({ length: 3 }, (_, i) => rec("brand_strategy", `bs-${i}`)),
      ...Array.from({ length: 17 }, (_, i) => rec("icp", `other-${i}`)),
      ...["avatar-role-map", "objections", "desired-outcomes", "language-patterns", "risk-and-fears"].map((k) =>
        rec("icp", k),
      ),
      ...Array.from({ length: 9 }, (_, i) => rec("offer_strategy", `other-${i}`)),
      rec("offer_strategy", "dream-outcome"),
      rec("offer_strategy", "guarantee"),
    ];
    expect(records).toHaveLength(36);
    expect(pillarContextPack(records)).toHaveLength(10);
  });
});
