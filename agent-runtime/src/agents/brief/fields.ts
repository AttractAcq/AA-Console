import { MAX_FRAMES, MIN_FRAMES, framePlanProblem, isMultiFrame } from "../../content/format.js";

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

/**
 * What these fields mean when the piece is a set of frames rather than one.
 *
 * Without these a carousel brief was written as if for a single picture —
 * "the on-image copy for a still", one block of words for what is actually
 * five separate images — and the frame breakdown was invented two steps
 * later by whoever rendered it, from a brief that never mentioned frames.
 *
 * Only the fields whose meaning genuinely changes. Premise, proof and
 * production notes mean the same thing whatever shape the piece runs in, and
 * restating them here would be four more strings to keep in step for nothing.
 */
const FRAMED_DESCRIPTIONS: Partial<Record<BriefField, string>> = {
  hook: "The first thing on frame 1. It has one job: earn the swipe. If frame 1 does not stop them, no later frame is read.",
  script: "The words across the whole set, in order, marked by frame. Not one block of copy — each frame carries its own line or two, and they have to read as a sequence.",
  visual_direction: "How the set should look. The same treatment, palette and world on every frame: these run together, and five frames in five styles is not one piece of work.",
  call_to_action: "The action asked for, which lands on the last frame. Earlier frames earn it rather than repeat it.",
};

export function fieldsFor(
  mediaType: string,
  contentFormat = "single",
): ReadonlyArray<readonly [string, string]> {
  const base =
    mediaType === "video" ? BRIEF_FIELDS : BRIEF_FIELDS.filter(([k]) => !VIDEO_ONLY.has(k));
  if (!isMultiFrame(contentFormat)) return base;
  return base.map(([name, description]) => [name, FRAMED_DESCRIPTIONS[name] ?? description]);
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
export function briefSubmitTool(
  mediaType: string,
  proofRefs: string[] = [],
  contentFormat = "single",
) {
  const fields = fieldsFor(mediaType, contentFormat);
  const refs = proofRefs.filter((r) => typeof r === "string" && r.trim());
  const framed = isMultiFrame(contentFormat);
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
        ...(framed
          ? {
              frames: {
                type: "array",
                // No maxItems: a strict schema rejects it. The bounds are
                // checked in framePlanProblem instead, the same way the
                // campaign idea count is.
                description: `What each frame is for, in the order they run. Between ${MIN_FRAMES} and ${MAX_FRAMES} entries. This decides the shape of the finished set, so no two frames should do the same job.`,
                items: {
                  type: "string",
                  description:
                    "One frame: what job it does in the sequence, and the gist of the words on it. One line.",
                },
              },
            }
          : {}),
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
      required: [
        "title",
        ...fields.map(([name]) => name),
        ...(framed ? ["frames"] : []),
        ...(refs.length ? ["proof_ref"] : []),
      ],
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
  frames: "Frames",
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
  contentFormat = "single",
): string {
  const parts: string[] = [];
  for (const [name] of fieldsFor(mediaType, contentFormat)) {
    const value = String(submitted[name] ?? "").trim();
    if (!value) continue;
    parts.push(`## ${LABELS[name] ?? name}\n\n${value}`);
  }
  // The sequence, in the readable brief as well as in the column. Whoever
  // opens the brief is looking at the thing that decides its shape, and a
  // plan that exists only as an array is invisible to them.
  const plan = framePlanFrom(submitted);
  if (isMultiFrame(contentFormat) && plan.length > 0) {
    const lines = plan.map((line, i) => `${i + 1}. ${line}`).join("\n");
    parts.push(`## Frames\n\n${lines}`);
  }
  return parts.join("\n\n");
}

/** The frame plan as the model returned it, trimmed. Empty if it returned none. */
export function framePlanFrom(submitted: Record<string, unknown>): string[] {
  const raw = submitted.frames;
  if (!Array.isArray(raw)) return [];
  return raw.map((line) => (typeof line === "string" ? line.trim() : ""));
}

/**
 * The frame columns for this brief, or why the plan cannot be stored.
 *
 * Returns nothing at all for a single: migration 113 refuses a frame count
 * on a format that has no frames, and the insert is one statement.
 *
 * A framed brief with no usable plan is a failure rather than a brief filed
 * without one. The plan is the thing that makes a carousel brief different
 * from an image brief — filing it blank would produce exactly the brief this
 * work exists to stop, and nothing downstream would report it.
 */
export function framePlanColumns(
  submitted: Record<string, unknown>,
  contentFormat: string,
): { columns: Record<string, unknown>; problem: string | null } {
  if (!isMultiFrame(contentFormat)) return { columns: {}, problem: null };
  const plan = framePlanFrom(submitted);
  const problem = framePlanProblem(plan);
  if (problem) return { columns: {}, problem };
  return { columns: { frame_plan: plan, frame_count: plan.length }, problem: null };
}

/** The columns to persist, minus production_notes which lives in the body. */
export function briefColumns(
  mediaType: string,
  submitted: Record<string, unknown>,
  contentFormat = "single",
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name] of fieldsFor(mediaType, contentFormat)) {
    if (name === "production_notes") continue;
    out[name] = String(submitted[name] ?? "").trim() || null;
  }
  return out;
}


/** Field subsets that belong on the avatar (talent) brief for video. */
const AVATAR_FIELDS: BriefField[] = [
  "hook",
  "premise",
  "script",
  "shot_requirements",
  "call_to_action",
  "production_notes",
];

/** Field subsets that belong on the editor brief for video. */
const EDITOR_FIELDS: BriefField[] = [
  "hook",
  "argument",
  "proof",
  "script",
  "visual_direction",
  "shot_requirements",
  "b_roll",
  "call_to_action",
  "channel_intent",
  "production_notes",
];

function composeRoleBody(
  fieldNames: readonly BriefField[],
  submitted: Record<string, unknown>,
  intro: string,
): string {
  const parts: string[] = [intro];
  for (const name of fieldNames) {
    const value = String(submitted[name] ?? "").trim();
    if (!value) continue;
    parts.push(`## ${LABELS[name] ?? name}\n\n${value}`);
  }
  return parts.join("\n\n");
}

/**
 * Talent-facing video brief. Performance, wardrobe/location, spoken lines,
 * framing for the person on camera — not captions, crops, or assembly rules.
 */
export function composeAvatarBody(submitted: Record<string, unknown>): string {
  return composeRoleBody(
    AVATAR_FIELDS,
    submitted,
    "# Avatar brief\n\nWhat you need to perform and shoot. Ignore edit, caption, and export notes — those go to the editor.",
  );
}

/**
 * Editor-facing video brief. Assembly, captions, crops, audio, delivery —
 * not wardrobe or "what not to say" performance constraints.
 */
export function composeEditorBody(submitted: Record<string, unknown>): string {
  return composeRoleBody(
    EDITOR_FIELDS,
    submitted,
    "# Editor brief\n\nWhat you need to cut, caption, and deliver. Include 9:16 / 4:5 / 1:1 crops unless the channel intent says otherwise. Do not invent music, graphics, or b-roll the brief forbids.",
  );
}
