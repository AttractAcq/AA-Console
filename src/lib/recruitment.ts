/**
 * Attract Acquisition hiring ads. Separate from paying-client campaigns:
 * tagged purpose=recruitment, attached to the house client, Meta static only.
 */

export const RECRUITMENT_ROLES = ["editor", "smm", "avatar"] as const;
export type RecruitmentRole = (typeof RECRUITMENT_ROLES)[number];

export const CONTENT_PURPOSES = ["client", "recruitment"] as const;
export type ContentPurpose = (typeof CONTENT_PURPOSES)[number];

export const RECRUITMENT_PURPOSE = "recruitment" as const;
export const RECRUITMENT_FORMAT = "meta_static" as const;
export const RECRUITMENT_CHANNEL = "Meta static";

/**
 * The call-to-action buttons Meta offers on a link ad.
 *
 * The CTA is a button chosen from Meta's fixed list, not a line somebody
 * writes. Four of the set make sense for a hiring ad pointing at an apply URL.
 *
 * Kept in step with META_CTAS in agent-runtime/src/recruitment/draft.ts, which
 * validates what the generator returns. Separate packages, so it exists twice.
 */
export const META_CTAS = [
  { value: "APPLY_NOW", label: "Apply now" },
  { value: "LEARN_MORE", label: "Learn more" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "CONTACT_US", label: "Contact us" },
] as const;

export const DEFAULT_CTA = "APPLY_NOW";

/**
 * The button's label, for a screen.
 *
 * Falls back to whatever is stored, because briefs written before the CTA was
 * a fixed value hold prose like "Apply now" and must keep rendering.
 */
export function ctaLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  const known = META_CTAS.find((c) => c.value === raw);
  return known ? known.label : raw;
}

export const RECRUITMENT_ROLE_LABEL: Record<RecruitmentRole, string> = {
  editor: "Editor",
  smm: "Social Media Manager",
  avatar: "Avatar",
};

export function isRecruitmentRole(value: string | null | undefined): value is RecruitmentRole {
  return value === "editor" || value === "smm" || value === "avatar";
}

// The three canned briefs that used to pre-fill this form are gone. They made
// every editor ad AA ran open with the same sentence, and they sat exactly
// where the operator's real knowledge of the opening needed to go. Briefs are
// now written per opening by /admin/recruitment/draft, or typed by hand.

export type RecruitmentCopyPack = {
  purpose: typeof RECRUITMENT_PURPOSE;
  role: RecruitmentRole;
  format: typeof RECRUITMENT_FORMAT;
  headline: string;
  primary_text: string;
  cta: string;
  apply_url: string;
  compensation: string | null;
  image: {
    asset_id: string;
    ref_number: string | null;
    storage_path: string;
  };
};

export type RecruitmentPackSource = {
  role: string | null;
  hook: string | null;
  script: string | null;
  call_to_action: string | null;
  apply_url: string | null;
  compensation_text: string | null;
  concept?: {
    headline?: unknown;
    subhead?: unknown;
    body?: unknown;
    call_to_action?: unknown;
  } | null;
  asset: {
    id: string;
    ref_number: string | null;
    storage_path: string;
  };
};

function line(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pack for download: generated concept copy wins, brief fields fill gaps.
 * Image + primary text / headline / CTA + apply URL + optional compensation.
 */
export function buildRecruitmentCopyPack(source: RecruitmentPackSource): RecruitmentCopyPack {
  if (!isRecruitmentRole(source.role)) {
    throw new Error("Copy pack requires a recruitment role of editor, smm or avatar.");
  }
  const apply = line(source.apply_url);
  if (!apply.startsWith("https://")) {
    throw new Error("Copy pack requires an https apply URL.");
  }
  const concept = source.concept ?? null;
  const headline = line(concept?.headline) || line(source.hook);
  const primary =
    line(concept?.subhead) || line(concept?.body) || line(source.script);
  // The brief wins here, unlike headline and primary text. The button is an
  // ad-level setting chosen from Meta's list; the creative concept has no say
  // in it, and its free-text call_to_action is copy for the image.
  const cta = line(source.call_to_action) || line(concept?.call_to_action);
  if (!headline || !primary || !cta) {
    throw new Error("Copy pack needs a headline, primary text and CTA.");
  }
  return {
    purpose: RECRUITMENT_PURPOSE,
    role: source.role,
    format: RECRUITMENT_FORMAT,
    headline,
    primary_text: primary,
    cta,
    apply_url: apply,
    compensation: line(source.compensation_text) || null,
    image: {
      asset_id: source.asset.id,
      ref_number: source.asset.ref_number,
      storage_path: source.asset.storage_path,
    },
  };
}

export function formatRecruitmentCopyPack(pack: RecruitmentCopyPack): string {
  const lines = [
    `FORMAT: Meta static`,
    `PURPOSE: ${pack.purpose}`,
    `ROLE: ${pack.role}`,
    `HEADLINE: ${pack.headline}`,
    `PRIMARY TEXT: ${pack.primary_text}`,
    `CTA BUTTON: ${ctaLabel(pack.cta)} (${pack.cta})`,
    `APPLY URL: ${pack.apply_url}`,
  ];
  if (pack.compensation) lines.push(`COMPENSATION: ${pack.compensation}`);
  lines.push(`IMAGE: ${pack.image.ref_number ?? pack.image.asset_id}`);
  lines.push(`STORAGE: ${pack.image.storage_path}`);
  return lines.join("\n");
}

export function downloadRecruitmentCopyPack(pack: RecruitmentCopyPack) {
  const blob = new Blob([formatRecruitmentCopyPack(pack)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${pack.role}-recruitment-copy-pack.txt`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
