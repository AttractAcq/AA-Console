/**
 * The shape of a production brief.
 *
 * A brief used to be one markdown body: readable by a person, opaque to
 * everything else. These are the fields the rest of the Content Production OS
 * needs — the Production Router reads channel intent and method, repurposing
 * reads hook and call to action, and the Iteration Engine learns against
 * exactly those two. "Hook X plus offer Y works" is unlearnable while the hook
 * is a sentence buried in prose.
 */
export const BRIEF_FIELDS = [
  ["hook", "The first thing the audience sees or hears. One line, concrete."],
  ["premise", "The idea restated in one line, so the maker knows what they are saying."],
  ["argument", "How the piece earns its claim: the reasoning, in order."],
  ["proof", "The specific proof point this piece makes. Empty if there is none on file — the piece must then work without one."],
  ["script", "The words. Spoken lines for video, the on-image copy for a still, the post itself for text."],
  ["visual_direction", "How this piece should look. Not the brand's permanent look — that is held elsewhere and applies anyway."],
  ["shot_requirements", "Video only. Shots the maker must capture. Empty for image and text."],
  ["b_roll", "Video only. Supporting footage. Empty for image and text."],
  ["call_to_action", "The action asked for."],
  ["channel_intent", "Where this is meant to run, which decides aspect, length and register."],
  ["production_notes", "Anything practical the maker must arrange that no field above covers: location, props, wardrobe, permissions."],
] as const;

export type BriefField = (typeof BRIEF_FIELDS)[number][0];

/** Fields that only mean something for video. */
const VIDEO_ONLY = new Set<BriefField>(["shot_requirements", "b_roll"]);

export function fieldsFor(mediaType: string): ReadonlyArray<readonly [string, string]> {
  return mediaType === "video" ? BRIEF_FIELDS : BRIEF_FIELDS.filter(([k]) => !VIDEO_ONLY.has(k));
}

/**
 * The tool schema, built from the same list the prompt describes.
 *
 * `proofRefs` are the references of the proof records actually offered to this
 * brief. When there are any, the schema gains a `proof_ref` whose allowed
 * values are exactly those references plus the empty string. That is the guard
 * that matters: an enum makes an invented reference impossible to submit,
 * where a free-text field would let the model cite proof that does not exist —
 * which is the same failure as an invented phone number, one step earlier.
 */
export function briefSubmitTool(mediaType: string, proofRefs: string[] = []) {
  const fields = fieldsFor(mediaType);
  const refs = proofRefs.filter((r) => typeof r === "string" && r.trim());
  return {
    name: "submit_brief",
    description: "Submit the finished production brief. Call this exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short production title for this piece." },
        ...Object.fromEntries(
          fields.map(([name, description]) => [name, { type: "string", description }]),
        ),
        ...(refs.length
          ? {
              proof_ref: {
                type: "string",
                enum: [...refs, ""],
                description:
                  "The reference of the proof record this piece relies on, chosen from the list you were given. Empty string if the piece makes no proof claim.",
              },
            }
          : {}),
      },
      // Every field is required so the model states an absence rather than
      // omitting it — the same discipline identity and brand follow. An empty
      // proof is a decision; a missing proof key is a silence.
      required: ["title", ...fields.map(([name]) => name), ...(refs.length ? ["proof_ref"] : [])],
      additionalProperties: false,
    },
  };
}

const LABELS: Record<string, string> = {
  hook: "Hook",
  premise: "Premise",
  argument: "Argument",
  proof: "Proof",
  script: "Script",
  visual_direction: "Visual direction",
  shot_requirements: "Shot requirements",
  b_roll: "B-roll",
  call_to_action: "Call to action",
  channel_intent: "Channel",
  production_notes: "Production notes",
};

/**
 * The readable brief, composed from the fields rather than written separately.
 *
 * Writing prose and structure as two outputs invites them to disagree, and the
 * one an editor reads would be the one nobody validated. Composing means there
 * is a single source of truth and the markdown is a view of it.
 */
export function composeBody(
  mediaType: string,
  submitted: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const [name] of fieldsFor(mediaType)) {
    const value = String(submitted[name] ?? "").trim();
    if (!value) continue;
    parts.push(`## ${LABELS[name] ?? name}\n\n${value}`);
  }
  return parts.join("\n\n");
}

/** The columns to persist, minus production_notes which lives in the body. */
export function briefColumns(
  mediaType: string,
  submitted: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name] of fieldsFor(mediaType)) {
    if (name === "production_notes") continue;
    out[name] = String(submitted[name] ?? "").trim() || null;
  }
  return out;
}
