// Whether a concept describes an image.
//
// The image route produced text cards. Not because the renderer failed — it
// rendered faithfully — but because the concepts asked for them:
//
//   "built entirely from typography and hairline rules ... no photography,
//    people, devices, icons, charts, badges or logos"
//
// The prompt said to be specific about what is in frame; nothing said the
// frame had to contain anything. Every other rule around it is prohibitive —
// invent no claim, render no phone number, leave the logo area clean — and a
// page of type on a brand colour satisfies all of them perfectly. The safest
// output was the wrong deliverable, so the model kept choosing it.
//
// The schema now asks for a background and a treatment with no typography-only
// option. This is the half that does not depend on the model cooperating: a
// constraint the model is merely asked to respect is not a constraint.

/** How the imagery is made. Deliberately no typography-only member. */
export const TREATMENTS = ["photographic", "illustrated", "rendered_3d", "textured_graphic"] as const;

/**
 * Phrases that announce there is nothing to look at.
 *
 * Matched only against `subject` and `background` — never `avoid`, which is
 * supposed to say "no stock-photo cliche" and would trip every one of these.
 */
const DECLARES_NO_IMAGERY = [
  /\bno photograph/i,
  /\bno imagery\b/i,
  /\bno illustration/i,
  /\bno people\b/i,
  /\bno scene\b/i,
  /\bentirely from typ/i,
  /\btypography only\b/i,
  /\bonly typ/i,
  /\btype-?only\b/i,
  /\bpurely typographic\b/i,
  /\bno background\b/i,
];

/** Enough words to be a description rather than a gesture at one. */
const MIN_BACKGROUND = 25;

/**
 * Why this concept would not produce an image, or null.
 *
 * Retryable by design: the model is told what it got wrong and asked again,
 * which is cheaper than a person discovering a text card in the approval queue
 * and sending the whole brief back.
 */
export function conceptProblem(concept: Record<string, unknown>): string | null {
  const text = (key: string) => {
    const raw = concept[key];
    return typeof raw === "string" ? raw.trim() : "";
  };

  const subject = text("subject");
  const background = text("background");

  if (!subject) return "The concept names no subject, so there is nothing in frame.";
  if (!background) {
    return "The concept describes no background. An image post has to show something behind the words.";
  }
  if (background.length < MIN_BACKGROUND) {
    return "The background is too thin to render. Describe the setting or scene, not a colour.";
  }

  const treatment = text("visual_treatment");
  if (!(TREATMENTS as readonly string[]).includes(treatment)) {
    return `"${treatment || "nothing"}" is not a way of making an image. Choose one of: ${TREATMENTS.join(", ")}.`;
  }

  for (const pattern of DECLARES_NO_IMAGERY) {
    if (pattern.test(subject) || pattern.test(background)) {
      return "This concept rules out imagery, which makes it a text post. Describe what the picture actually shows — a person, a place, an object, a scene.";
    }
  }

  return null;
}
