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

// ---------------------------------------------------------------------------
// Recruitment: the ad has to say it is a job ad.
//
// The first three hiring ads AA generated read as advertising for AA's
// services. "Six practices. Six voices. Not yours." is a good line and, on a
// dental practice's feed, it sells social media management. Nothing on any of
// them said the agency was hiring.
//
// The cause was upstream of the copy: creative_build selected title, body and
// media_type from the brief and nothing else, so a recruitment brief arrived
// looking exactly like a client campaign brief. The agent wrote a good ad for
// the wrong job because it was never told which job it had.
//
// A hiring ad has one thing it cannot leave out, and this is the check for it.

/** How each role may be named on the ad. Generous, because the words vary. */
const ROLE_TERMS: Record<string, string[]> = {
  editor: ["editor", "editing"],
  smm: ["social media manager", "social media", "smm"],
  avatar: ["avatar", "on camera", "on-camera", "face of"],
};

/** Plain statements that this is a job. "Apply" alone is not one — a CTA says that. */
const HIRING_SIGNAL =
  /\b(hiring|we'?re hiring|now hiring|recruiting|vacancy|vacancies|join the team|join our team|this role|the role|position)\b/i;

/**
 * Why this concept would not read as a hiring ad, or null.
 *
 * Checks the words that actually get set as type on the image — headline,
 * subhead and call to action — because that is all a reader sees while
 * scrolling. Reasoning in the rationale does not reach them.
 */
export function recruitmentConceptProblem(
  concept: Record<string, unknown>,
  role: string,
): string | null {
  const text = (key: string) => {
    const raw = concept[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const rendered = [text("headline"), text("subhead"), text("call_to_action")]
    .filter(Boolean)
    .join(" ");

  if (!rendered) return "The ad carries no text, so nothing on it says a job is open.";

  if (!HIRING_SIGNAL.test(rendered)) {
    return "Nothing on this ad says anybody is hiring. Put it in the headline or the subhead — a reader scrolling past must see that a job is open, not an agency advertising its services.";
  }

  const terms = ROLE_TERMS[role] ?? [];
  if (terms.length > 0 && !terms.some((term) => rendered.toLowerCase().includes(term))) {
    return `The ad never names the role. Say which job is open, in words an applicant would recognise (${terms.join(", ")}).`;
  }

  return null;
}

/**
 * What the last attempt got wrong, for a build that replaces a rejected one.
 *
 * Empty for a first build, so the caller interpolates it unconditionally.
 *
 * It is worded as an instruction rather than as background because the brief
 * has not changed: a concept handed the same brief and a note about the
 * rejection will otherwise write the same concept and soften one phrase.
 */
export function remakeBlock(feedback: string): string {
  const said = feedback.trim();
  if (!said) return "";
  return `THIS IS A REMAKE — the last attempt at this brief was rejected
What was wrong with it: ${said}

Fix that specifically. The brief has not changed, so a concept that does not differ on the point above is the same rejection again. Do not merely soften the thing that was objected to.

`;
}
