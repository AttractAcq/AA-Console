/**
 * What QA can decide without asking a model.
 *
 * M3.9. The build plan lists four things to check — brand, claims, platform
 * rules and plain risk — and three of them are arithmetic or string work.
 * Only "does this claim have proof behind it" needs judgement, and even that
 * narrows to a shortlist first.
 *
 * Separated from the agent so the rules can be tested against text rather
 * than against a mocked model, and so the score is reproducible: the same
 * copy and the same asset give the same number every time, which matters
 * when the number decides whether a client's money is spent again.
 */

import { checkCopy, type CopyDraft, type Platform } from "../../content/platform-limits.js";

export type Severity = "blocker" | "warning";

export interface Finding {
  /** What kind of problem. Grouped in the approval card. */
  area: "brand" | "claims" | "platform" | "risk";
  severity: Severity;
  /** One sentence a person can act on. */
  detail: string;
}

/** Each blocker costs this much of the 100. */
const BLOCKER_COST = 25;
const WARNING_COST = 8;

/**
 * Health and money claims a small business cannot make casually, and the
 * words that signal one.
 *
 * Deliberately a short list of strong signals rather than a long list of
 * weak ones. A checker that flags "help" or "better" flags everything, and
 * a QA step that always fires is one people learn to wave through.
 */
const RISK_PHRASES: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /\b(cure|cures|cured|heal|heals)\b/i, detail: "says something cures or heals" },
  { pattern: /\b(guarantee|guaranteed|guarantees)\b/i, detail: "guarantees an outcome" },
  { pattern: /\b(risk[- ]?free|no risk)\b/i, detail: "calls it risk-free" },
  { pattern: /\b(pain[- ]?free|painless)\b/i, detail: "promises no pain" },
  { pattern: /\b(FDA|clinically proven|medically proven)\b/i, detail: "claims clinical or regulatory backing" },
  { pattern: /\b(double|triple|10x|ten times)\s+(your|their)\b/i, detail: "promises a multiple of something" },
  { pattern: /\bpassive income\b/i, detail: "promises passive income" },
  { pattern: /\b(best|number one|#1|leading)\s+(in|agency|provider|clinic|dentist)/i, detail: "claims to be the best" },
];

/** A number that is not a date, a time, a year or a hashtag. */
export function figuresIn(text: string): string[] {
  const out: string[] = [];
  // Strip the things that look like figures and are not claims.
  const cleaned = text
    .replace(/#\w+/g, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,2}(st|nd|rd|th)\b/gi, " ");
  // No trailing \b: a word boundary after "%" never matches, so "47%" came
  // back as "47" and compared unequal to the "47%" in the brief.
  for (const match of cleaned.matchAll(/\b\d+(?:[.,]\d+)?%?/g)) {
    out.push(match[0]);
  }
  return [...new Set(out)];
}

export interface QaInput {
  platform: Platform;
  format: string;
  copy: CopyDraft & { cta?: string | null };
  /** From client_brand_profiles.never_do, already split. */
  bannedPhrases: readonly string[];
  /** Text of the brief, which is the only place a figure may legitimately come from. */
  briefText: string;
  /** Whether any cleared proof exists for this client. */
  hasProof: boolean;
  /** Dimensions of the asset, when known. */
  asset?: { width?: number | null; height?: number | null; durationSec?: number | null } | null;
}

/** 9:16 within a tolerance, because a render can be a pixel out. */
export function isVertical(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height - 9 / 16) < 0.02;
}

/** Reels and stories are vertical; nothing else is required to be. */
const VERTICAL_FORMATS = new Set(["reel", "story"]);
/** Beyond this a reel stops being a reel. */
const MAX_REEL_SECONDS = 90;

export function qaFindings(input: QaInput): Finding[] {
  const findings: Finding[] = [];
  const text = [input.copy.caption, input.copy.first_comment, input.copy.cta, (input.copy.hashtags ?? []).join(" ")]
    .filter(Boolean)
    .join(" ");

  // --- brand -------------------------------------------------------------
  for (const phrase of input.bannedPhrases) {
    const needle = phrase.trim().toLowerCase();
    if (needle && text.toLowerCase().includes(needle)) {
      findings.push({
        area: "brand",
        severity: "blocker",
        detail: `The copy says "${phrase.trim()}", which this brand does not say.`,
      });
    }
  }

  // --- platform ----------------------------------------------------------
  for (const problem of checkCopy(input.platform, input.copy)) {
    findings.push({ area: "platform", severity: "blocker", detail: problem });
  }

  const { width, height, durationSec } = input.asset ?? {};
  if (VERTICAL_FORMATS.has(input.format) && width && height && !isVertical(width, height)) {
    findings.push({
      area: "platform",
      severity: "blocker",
      detail: `A ${input.format} has to be 9:16. This is ${width}×${height}.`,
    });
  }
  if (input.format === "reel" && durationSec && durationSec > MAX_REEL_SECONDS) {
    findings.push({
      area: "platform",
      severity: "warning",
      detail: `This reel runs ${Math.round(durationSec)}s. Past ${MAX_REEL_SECONDS}s it stops being a reel.`,
    });
  }

  // --- claims ------------------------------------------------------------
  // A figure on screen that the brief does not contain is a claim nobody
  // approved. The same rule the editor applies to captions, applied here to
  // everything that goes out with the post.
  const briefFigures = new Set(figuresIn(input.briefText));
  for (const figure of figuresIn(text)) {
    if (!briefFigures.has(figure)) {
      findings.push({
        area: "claims",
        severity: "blocker",
        detail: `The copy says "${figure}", which is not in the brief.`,
      });
    }
  }
  if (!input.hasProof && briefFigures.size > 0) {
    findings.push({
      area: "claims",
      severity: "warning",
      detail: "The brief carries figures and this client has no cleared proof on file to stand them up.",
    });
  }

  // --- risk --------------------------------------------------------------
  for (const { pattern, detail } of RISK_PHRASES) {
    if (pattern.test(text)) {
      findings.push({
        area: "risk",
        severity: "blocker",
        detail: `The copy ${detail}. That needs a person to agree to it.`,
      });
    }
  }

  return findings;
}

/** 100 down to 0, never below. */
export function qaScore(findings: readonly Finding[]): number {
  const cost = findings.reduce(
    (total, f) => total + (f.severity === "blocker" ? BLOCKER_COST : WARNING_COST),
    0,
  );
  return Math.max(0, 100 - cost);
}

export function qaSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "Nothing to flag.";
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const warnings = findings.length - blockers;
  const parts: string[] = [];
  if (blockers > 0) parts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return parts.join(" and ") + ".";
}
