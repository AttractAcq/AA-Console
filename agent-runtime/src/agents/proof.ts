import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The proof a client may actually use, as an agent needs to hear it.
 *
 * Proof used to reach agents as "- Title (source): body" — a filing cabinet
 * read aloud. An agent given that cannot tell a cleared customer result from
 * an uncleared Google review, so it does the safe thing and cites neither.
 * That is exactly what happened: a live brief said "No proof point is used,
 * deliberately. The single item on file is a Google review."
 *
 * usable_proof does the filtering in the database — cleared, unexpired,
 * strongest first — so what arrives here is already safe to cite. What this
 * adds is saying so, and saying plainly when the list is empty and why.
 */
export interface ProofRecord {
  ref_number: string | null;
  proof_type: string | null;
  title: string | null;
  claim: string | null;
  evidence: string | null;
  avatar_relevance: string | null;
  services: string | null;
  strength: string;
  body: string | null;
  source: string | null;
  captured_on: string | null;
}

export async function loadUsableProof(
  sb: SupabaseClient,
  clientId: string,
  avatar?: string | null,
): Promise<ProofRecord[]> {
  const { data } = await sb.rpc("usable_proof", {
    p_client_id: clientId,
    p_avatar: avatar ?? undefined,
    p_limit: 12,
  });
  return (data ?? []) as ProofRecord[];
}

function line(label: string, value: string | null): string | null {
  return value && value.trim() ? `  ${label}: ${value.trim()}` : null;
}

/**
 * Renders proof so an agent can pick one and cite it exactly. The reference
 * is included because a brief that names PRF-style ref can be traced back to
 * the record that justified the claim.
 */
export function renderProof(records: ProofRecord[], counts?: { held: number }): string {
  if (records.length === 0) {
    // Absence stated, and the reason distinguished. "None on file" and "some
    // on file but none cleared for use" call for different action from the
    // operator, and only the second is a job someone can go and do.
    const held = counts?.held ?? 0;
    return held > 0
      ? `None usable. ${held} proof record${held === 1 ? " is" : "s are"} on file but not cleared for use, so this piece must work without a proof claim. Say so rather than implying one.`
      : "None on file. This piece must work without a proof claim. Say so rather than implying one.";
  }

  return records
    .map((p) => {
      const head = `- ${p.ref_number ?? "unreferenced"} · ${p.proof_type ?? "proof"} · strength ${p.strength}`;
      const rest = [
        line("Claim", p.claim ?? p.title),
        line("Evidence", p.evidence ?? p.body),
        line("Lands with", p.avatar_relevance),
        line("Service", p.services),
        line("Source", p.source),
        line("Captured", p.captured_on),
      ].filter(Boolean);
      return [head, ...rest].join("\n");
    })
    .join("\n\n");
}
