/**
 * The words on a Meta ad, drafted from the brief and checked before saving.
 *
 * An approved asset is a picture. The Meta build turns it into an ad only
 * once it carries copy — primary text, a headline, a link and a button — and
 * none of those had anywhere to be written, so no asset ever had any. The
 * brief already holds where the copy comes from (hook, premise, call to
 * action); this turns that into a first draft a person edits, rather than a
 * blank form nobody fills in.
 *
 * The checks mirror the ones the build runs (agent-runtime/src/meta/creative.ts)
 * so a mistake shows up when the copy is written, not a day later as a failed
 * build. The build still checks again: this is for the person, that is for
 * Meta.
 */

import { META_CTAS } from "./metaCta";

export interface AdCopy {
  ad_primary_text: string;
  ad_headline: string;
  ad_description: string;
  ad_link_url: string;
  ad_cta: string;
}

/** Meta cuts a headline off around here on most placements. */
export const HEADLINE_LIMIT = 40;

type BriefSource = {
  title?: string | null;
  hook?: string | null;
  premise?: string | null;
  argument?: string | null;
  call_to_action?: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Shortens at a word boundary, so a headline never ends mid-word. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit + 1);
  const space = cut.lastIndexOf(" ");
  return (space > limit / 2 ? cut.slice(0, space) : text.slice(0, limit)).replace(/[\s,;:.-]+$/, "");
}

/**
 * A first draft. Every field is a suggestion the form shows, never something
 * written without a person saving it.
 *
 * The button is the brief's own call to action when it is one this campaign
 * can carry, otherwise the template's most apt one. A brief written before
 * CTAs were a fixed list holds prose like "Book your visit", which is not a
 * button Meta has.
 */
export function draftAdCopy(args: {
  brief: BriefSource | null;
  landingUrl: string | null;
  allowedCtas: readonly string[];
}): AdCopy {
  const { brief, landingUrl, allowedCtas } = args;
  const hook = clean(brief?.hook);
  const body = clean(brief?.premise) || clean(brief?.argument);
  const primary = [hook, body].filter(Boolean).join("\n\n");

  const briefCta = clean(brief?.call_to_action).toUpperCase().replace(/\s+/g, "_");
  const cta = allowedCtas.includes(briefCta) ? briefCta : (allowedCtas[0] ?? "");

  return {
    ad_primary_text: primary,
    ad_headline: clip(clean(brief?.title) || hook, HEADLINE_LIMIT),
    ad_description: "",
    ad_link_url: clean(landingUrl),
    ad_cta: cta,
  };
}

/** Saved copy where there is some, the draft where there is none, field by field. */
export function mergeCopy(saved: Partial<Record<keyof AdCopy, string | null>>, draft: AdCopy): AdCopy {
  const pick = (key: keyof AdCopy) => (clean(saved[key]) ? (saved[key] as string) : draft[key]);
  return {
    ad_primary_text: pick("ad_primary_text"),
    ad_headline: pick("ad_headline"),
    ad_description: pick("ad_description"),
    ad_link_url: pick("ad_link_url"),
    ad_cta: pick("ad_cta"),
  };
}

/** Why this copy would not build, or an empty list. */
export function adCopyProblems(copy: AdCopy, allowedCtas: readonly string[]): string[] {
  const problems: string[] = [];
  if (!clean(copy.ad_primary_text)) problems.push("Primary text is required.");
  if (!clean(copy.ad_headline)) problems.push("A headline is required.");
  const link = clean(copy.ad_link_url);
  if (!link) problems.push("A link is required: where the ad sends people.");
  else if (!/^https:\/\/\S+$/i.test(link)) problems.push(`"${link}" must be a full https:// address.`);

  const cta = clean(copy.ad_cta);
  if (cta) {
    if (!META_CTAS.some((c) => c.value === cta)) problems.push(`"${cta}" is not a Meta button.`);
    else if (allowedCtas.length > 0 && !allowedCtas.includes(cta)) {
      problems.push(`This campaign's template allows: ${allowedCtas.join(", ")}.`);
    }
  }
  return problems;
}

/** What is written to client_media_assets: blanks become null, not empty strings. */
export function toColumns(copy: AdCopy): Record<keyof AdCopy, string | null> {
  const value = (v: string) => (clean(v) ? v.trim() : null);
  return {
    ad_primary_text: value(copy.ad_primary_text),
    ad_headline: value(copy.ad_headline),
    ad_description: value(copy.ad_description),
    ad_link_url: value(copy.ad_link_url),
    ad_cta: value(copy.ad_cta),
  };
}
