/**
 * Running ideation inside one content pillar.
 *
 * An unscoped run fills a bank: twenty-five ideas spread across everything
 * the brand talks about. A scoped run fills a pillar: twelve ideas that all
 * argue the same position from different angles, which is what a month of one
 * pillar actually needs.
 *
 * The boundary does the work. A pillar's `does_not_belong` is what stops the
 * run drifting into the neighbouring pillar by idea nine, and it is given to
 * the model as an instruction rather than left implied.
 */

export interface PillarScope {
  id: string;
  name: string;
  premise: string;
  belongs: string;
  does_not_belong: string;
}

/**
 * The prompt section that confines a run to one pillar.
 *
 * Returns empty for an unscoped run, so the caller interpolates it
 * unconditionally rather than branching around it.
 */
export function pillarBrief(pillar: PillarScope | null): string {
  if (!pillar) return "";
  return `THE PILLAR THIS RUN IS CONFINED TO — every idea must sit inside it
**${pillar.name}**
What it argues: ${pillar.premise}
What belongs in it: ${pillar.belongs}
What does NOT belong in it, however much it looks like it might: ${pillar.does_not_belong}

Every idea in this run sits in this pillar. An idea that would be better in another pillar is not a better idea, it is the wrong idea for this run — leave it out. Vary the angle within the pillar rather than widening the pillar to fit a good idea you thought of.`;
}

/**
 * What a pillar-scoped run stores on each idea.
 *
 * `content_territory` is set to the pillar's name rather than left to the
 * model. On an unscoped run that column holds whatever territory the model
 * invented, which is the historical record and stays untouched; on a scoped
 * run the territory is not in question, and letting the model restate it in
 * its own words is how "Continuity and certainty" became "Continuity and
 * Certainty" in the first place.
 */
export function pillarFields(
  pillar: PillarScope | null,
  modelTerritory: string,
): { pillar_id: string | null; content_territory: string | null } {
  if (pillar) {
    return { pillar_id: pillar.id, content_territory: pillar.name };
  }
  return { pillar_id: null, content_territory: modelTerritory.trim() || null };
}

/** How an idea bank records where this run came from. */
export function ideaSource(inputTable: string | null | undefined): "auto" | "proof" | "pillar" {
  if (inputTable === "client_proof_assets") return "proof";
  if (inputTable === "client_content_pillars") return "pillar";
  return "auto";
}
