/** Verify the exact reviewed bytes before preparing a public Meta request. */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS } from "../storage/signed-url-policy.js";
import { formatFitsMedia, isContentFormat, platformAllowsFormat } from "../content/format.js";
import { isPlatform } from "../content/platform-limits.js";
import { PublishError } from "./types.js";

const BUCKET = "publication-media";
const MAX_BYTES = 524_288_000;
const SHA = /^[0-9a-f]{64}$/;
const RIGHTS = new Set(["client_owned", "licensed", "agency_owned"]);

type ObjectRow = Record<string, unknown>;
type FrozenMedia = {
  frozen_path: string; sha256: string; byte_size: number; mime_type: string;
  source_path: string;
};
export type VerifiedPublicationPackage = {
  artifactHash: string;
  accountRef: string;
  caption: string;
  firstComment: string | null;
  altText: string | null;
  contentFormat: string;
  mediaType: string;
  mediaUrls: string[];
};

function object(value: unknown): ObjectRow | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRow : null;
}

function mediaOf(value: unknown, clientId: string): FrozenMedia[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new PublishError("Approved publication has no valid frozen media list.", false);
  }
  return value.map((entry, index) => {
    const row = object(entry);
    const sha = row?.sha256;
    const path = row?.frozen_path;
    const source = row?.source_path;
    const size = row?.byte_size;
    const mime = row?.mime_type;
    if (row?.frozen_bucket !== BUCKET || typeof sha !== "string" || !SHA.test(sha)
      || path !== `${clientId}/${sha}` || typeof source !== "string"
      || !source.startsWith(`${clientId}/`) || source.length <= clientId.length + 1
      || source.includes("..")
      || typeof size !== "number" || !Number.isSafeInteger(size)
      || size < 1 || size > MAX_BYTES || typeof mime !== "string"
      || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
      throw new PublishError(`Frozen publication frame ${index + 1} is malformed.`, false);
    }
    return { frozen_path: path, sha256: sha, byte_size: size,
      mime_type: mime, source_path: source };
  });
}

/** The RPC will eventually return this envelope only for a current AAL2-approved package. */
export async function verifyFrozenPublicationPackage(
  sb: SupabaseClient,
  raw: unknown,
  expected: { clientId: string; postId: string; platform: string; scheduledAt: string;
    accountRef?: string; provider?: string; contentFormat?: string | null; mediaType?: string | null },
): Promise<VerifiedPublicationPackage> {
  const envelope = object(raw);
  const manifest = object(envelope?.manifest);
  const copy = object(manifest?.provider_copy);
  const sourceCopy = object(manifest?.copy);
  const rights = object(manifest?.rights);
  const artifactHash = envelope?.artifact_hash;
  const accountRef = manifest?.account_ref;
  const caption = copy?.caption;
  const firstComment = copy?.first_comment;
  const altText = sourceCopy?.alt_text;
  const contentFormat = manifest?.content_format;
  const mediaType = manifest?.media_type;
  const scheduledAt = manifest?.scheduled_at;
  if (typeof artifactHash !== "string" || !SHA.test(artifactHash)
    || manifest?.client_id !== expected.clientId
    || manifest?.scheduled_post_id !== expected.postId
    || manifest?.platform !== expected.platform
    || expected.provider !== undefined && manifest?.provider !== expected.provider
    || typeof scheduledAt !== "string"
    || !Number.isFinite(Date.parse(scheduledAt))
    || !Number.isFinite(Date.parse(expected.scheduledAt))
    || Date.parse(scheduledAt) !== Date.parse(expected.scheduledAt)
    || typeof accountRef !== "string" || !accountRef.trim()
    || expected.accountRef !== undefined && accountRef !== expected.accountRef
    || typeof caption !== "string" || !caption.trim()
    || firstComment !== null && typeof firstComment !== "string"
    || altText !== null && altText !== undefined && typeof altText !== "string"
    || typeof contentFormat !== "string" || !isContentFormat(contentFormat)
    || typeof mediaType !== "string" || !["image", "video"].includes(mediaType)
    || expected.contentFormat != null && contentFormat !== expected.contentFormat
    || expected.mediaType != null && mediaType !== expected.mediaType
    || !platformAllowsFormat(expected.platform, contentFormat)
    || !formatFitsMedia(contentFormat, mediaType)
    || !isPlatform(expected.platform)
    || !RIGHTS.has(String(rights?.usage_rights))) {
    throw new PublishError("Approved publication package does not match this post.", false);
  }
  const media = mediaOf(manifest.media, expected.clientId);
  const paths = manifest.source_paths;
  if (!Array.isArray(paths) || paths.length !== media.length
    || media.some((item, index) => item.source_path !== paths[index])) {
    throw new PublishError("Frozen publication order differs from its reviewed source.", false);
  }
  if (contentFormat === "carousel" && media.length < 2
    || contentFormat === "story" && media.length < 1
    || !["carousel", "story"].includes(contentFormat) && media.length !== 1) {
    throw new PublishError("Frozen publication frame count is invalid.", false);
  }

  const mediaUrls: string[] = [];
  for (const item of media) {
    const { data, error } = await sb.storage.from(BUCKET).download(item.frozen_path);
    if (error || !data) throw new PublishError(`Approved frozen media frame ${mediaUrls.length + 1} is unavailable.`, true);
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.length !== item.byte_size
      || createHash("sha256").update(bytes).digest("hex") !== item.sha256
      || data.type.trim().toLowerCase() !== item.mime_type) {
      throw new PublishError("Approved frozen media bytes changed.", false);
    }
    const { data: signed, error: signError } = await sb.storage.from(BUCKET)
      .createSignedUrl(item.frozen_path, PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl?.startsWith("https://")) {
      throw new PublishError(`Approved frozen media frame ${mediaUrls.length + 1} could not be signed.`, true);
    }
    mediaUrls.push(signed.signedUrl);
  }
  return { artifactHash, accountRef, caption, firstComment: firstComment as string | null,
    altText: typeof altText === "string" ? altText : null,
    contentFormat, mediaType, mediaUrls };
}
