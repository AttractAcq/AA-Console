/**
 * The records a pillar proposal actually reads.
 *
 * The first version of this route handed the model every brand_strategy, icp
 * and offer_strategy record on file — 36 records and 84,000 characters for
 * one real client, which timed out before it answered.
 *
 * The timeout was the symptom. The mistake was ignoring the rule the ideation
 * architecture states about itself: "Ideation must never receive the whole
 * intelligence corpus... a model given everything produces generic ideas
 * because nothing is salient." Pillars are the layer above ideation and the
 * rule applies at least as hard — a pillar drawn from everything is a pillar
 * about nothing.
 *
 * So: brand strategy in full, because it is already the compression layer and
 * is the thing pillars are drawn from; the ICP sections that say what this
 * buyer needs to hear; and the two offer sections that say what is being sold.
 * The same selection ideation makes, for the same reason.
 */

import type { UpstreamRecord } from "../agents/shared.js";

/** What this buyer needs to hear, rather than everything known about them. */
const ICP_SECTIONS = [
  "avatar-role-map",
  "objections",
  "desired-outcomes",
  "language-patterns",
  "risk-and-fears",
];

const OFFER_SECTIONS = ["dream-outcome", "guarantee"];

export function pillarContextPack(records: readonly UpstreamRecord[]): UpstreamRecord[] {
  return records.filter((r) => {
    if (r.domain === "brand_strategy") return true;
    if (r.domain === "icp") return ICP_SECTIONS.includes(r.item_key);
    if (r.domain === "offer_strategy") return OFFER_SECTIONS.includes(r.item_key);
    return false;
  });
}
