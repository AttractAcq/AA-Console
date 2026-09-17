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

export const RECRUITMENT_ROLE_LABEL: Record<RecruitmentRole, string> = {
  editor: "Editor",
  smm: "Social Media Manager",
  avatar: "Avatar",
};

export function isRecruitmentRole(value: string | null | undefined): value is RecruitmentRole {
  return value === "editor" || value === "smm" || value === "avatar";
}

export type RecruitmentBriefTemplate = {
  role: RecruitmentRole;
  title: string;
  hook: string;
  premise: string;
  script: string;
  call_to_action: string;
  visual_direction: string;
  channel_intent: typeof RECRUITMENT_CHANNEL;
};

/**
 * Role-aware subset of the structured brief: headline, primary text, CTA,
 * visual direction. No video fields, no LinkedIn pack.
 */
export const RECRUITMENT_TEMPLATES: Record<RecruitmentRole, RecruitmentBriefTemplate> = {
  editor: {
    role: "editor",
    title: "Editor — Attract Acquisition",
    hook: "Cut the work that actually ships",
    premise: "We hire editors who finish on-brand assets, not decorate a brief.",
    script:
      "Attract Acquisition is hiring an editor. You take an approved brief and turn it into a still that looks like the client — dental and healthcare, tight turnaround, no stock-photo filler.",
    call_to_action: "Apply now",
    visual_direction:
      "Quiet studio desk, documentary light, real tools in frame. Attract Acquisition palette. No handshake stock, no floating laptops.",
    channel_intent: RECRUITMENT_CHANNEL,
  },
  smm: {
    role: "smm",
    title: "Social Media Manager — Attract Acquisition",
    hook: "Run the feed like an operator, not a poster",
    premise: "SMM here means owning the calendar, the voice, and the next asset — not collecting likes.",
    script:
      "Attract Acquisition is hiring a social media manager. You run organic and paid stills for healthcare clients: briefs, approvals, captions, and the Meta static that has to look like the practice.",
    call_to_action: "Apply now",
    visual_direction:
      "Phone in a calm hand, a real practice feed on screen, natural window light. Attract Acquisition palette. No influencer posing, no sparkle overlays.",
    channel_intent: RECRUITMENT_CHANNEL,
  },
  avatar: {
    role: "avatar",
    title: "Avatar — Attract Acquisition",
    hook: "On camera for practices that would rather not be",
    premise: "Avatars here are the face of the work — on-brief, on-brand, no ad-libbed clinical claims.",
    script:
      "Attract Acquisition is hiring an avatar. You appear in stills for dental and healthcare clients: the face in frame, the line on the brief, nothing invented about the medicine.",
    call_to_action: "Apply now",
    visual_direction:
      "One person, mid-conversation, natural window light from camera left. Attract Acquisition palette. No hard-hat hero shot, no stock smile.",
    channel_intent: RECRUITMENT_CHANNEL,
  },
};

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
  const cta = line(concept?.call_to_action) || line(source.call_to_action);
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
    `CTA: ${pack.cta}`,
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
