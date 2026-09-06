// What a creative concept actually needs to know.
//
// The first version sent every record from icp, brand_strategy and
// offer_strategy — 36 records, ~21,000 tokens of a 33,484-token prompt. That
// is the thing the design doc this feature came from warns about in its own
// words: do not dump the whole client brain into every generation request.
//
// The duplication is worse than the size. The brief is DOWNSTREAM of these
// domains — the brief agent read the ICP and the brand strategy to write it —
// so sending the brief and all of its source material asks the model to
// re-derive reasoning that already happened, and pays for it.
//
// So this is an allow-list, chosen by what a single image or piece of copy
// actually uses, with a per-record cap for the few that run long.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UpstreamRecord } from "../shared.js";

/** Long records are truncated rather than dropped: the opening is the summary. */
const MAX_RECORD_CHARS = 2000;

const WANTED: Record<string, string[]> = {
  // How the buyer talks, what they want, what they fear, and how they see
  // themselves. Everything a headline, a piece of copy or an art direction
  // is built from.
  icp: [
    "language-patterns",
    "objections",
    "risk-and-fears",
    "desired-outcomes",
    "core-pain",
    "emotional-triggers",
    "visual-identity",
    "demographic-profile",
  ],
  // What is promised and what may not be claimed. The bonuses, time delay
  // and effort sections describe how the offer is constructed, which a
  // single creative does not need.
  offer_strategy: ["dream-outcome", "guarantee", "scarcity", "urgency"],
  // These are planning documents — cross-OS synthesis and portfolio
  // recommendations run to 9,000 characters each. Only the one that carries
  // the guardrails is worth passing, and only its opening.
  brand_strategy: ["strategic-recommendations"],
};

export const CONCEPT_DOMAINS = Object.keys(WANTED);

/**
 * Loads only the sections above. Returns the same shape as
 * loadUpstreamRecords so the prompt builder does not care which was used.
 */
export async function loadConceptContext(
  sb: SupabaseClient,
  clientId: string,
): Promise<UpstreamRecord[]> {
  const keys = Object.values(WANTED).flat();
  const { data, error } = await sb
    .from("client_agent_records")
    .select("domain, item_key, title, body")
    .eq("client_id", clientId)
    .in("domain", CONCEPT_DOMAINS)
    .in("item_key", keys);
  if (error) throw new Error(`Could not load creative context: ${error.message}`);

  const rows = (data ?? []) as UpstreamRecord[];

  // item_key is only unique within a domain, so the pair has to be checked —
  // otherwise a shared key would let one domain's record stand in for
  // another's.
  return rows
    .filter((r) => WANTED[r.domain]?.includes(r.item_key))
    .map((r) => ({
      ...r,
      body:
        r.body && r.body.length > MAX_RECORD_CHARS
          ? `${r.body.slice(0, MAX_RECORD_CHARS)}\n[…trimmed]`
          : r.body,
    }));
}
