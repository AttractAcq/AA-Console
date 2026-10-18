/**
 * Copy a completed Higgsfield clip into our storage.
 *
 * The provider CDN keeps a clip for about a week. Once a poll says
 * completed and hands over video.url, the bytes are downloaded and stored
 * in the client-media bucket creative_build already uses. clip_path on
 * client_media_frames is that object path. The CDN URL is not stored.
 *
 * Upload uses upsert: false. A path that already exists fails without
 * replacing the file. Any other upload failure removes the object so a
 * partial write is not left behind.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Same bucket creative_build writes stills to. */
export const CLIENT_MEDIA_BUCKET = "client-media";

/** Cockpit check-shot-generation uses about two minutes for the download. */
export const CLIP_DOWNLOAD_TIMEOUT_MS = 120_000;

export class ClipStoreError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ClipStoreError";
    this.retryable = retryable;
  }
}

export function clipStoragePath(clientId: string, frameId: string): string {
  const client = pathSegment(clientId, "client");
  const frame = pathSegment(frameId, "frame");
  return `${client}/generated/clips/${frame}.mp4`;
}

function pathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ClipStoreError(`A clip ${label} is not a usable path segment.`, false);
  }
  return trimmed;
}

function isDuplicate(error: { message: string; statusCode?: string | number }): boolean {
  if (String(error.statusCode) === "409") return true;
  return /already exists|duplicate/i.test(error.message);
}

async function downloadClipBytes(
  videoUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ bytes: Buffer; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(videoUrl);
  } catch {
    throw new ClipStoreError("Motion completed without a usable video URL, so the clip was not copied.", false);
  }
  if (parsed.protocol !== "https:") {
    throw new ClipStoreError("A completed clip is only downloaded over https.", false);
  }

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (caught) {
    const name = caught instanceof Error ? caught.name : "Error";
    throw new ClipStoreError(`Could not download the completed clip (${name}).`, true);
  }
  if (!response.ok) {
    throw new ClipStoreError(`Could not download the completed clip (${response.status}).`, response.status >= 500);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ClipStoreError("The completed clip was empty, so it was not stored.", true);
  }
  const header = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const contentType = header.startsWith("video/") ? header : "video/mp4";
  return { bytes, contentType };
}

/**
 * Download video.url and record clip_path.
 * Returns null when the poll is not completed yet. An existing clip_path
 * is kept and not downloaded again. fetchImpl downloads the URL it is
 * given; this does not call the Higgsfield API.
 */
export async function persistCompletedClip(
  sb: SupabaseClient,
  input: {
    clientId: string;
    frameId: string;
    status: string;
    videoUrl?: string | null;
    existingClipPath?: string | null;
    fetchImpl: typeof fetch;
    timeoutMs?: number;
  },
): Promise<string | null> {
  if (input.status.trim().toLowerCase() !== "completed") return null;
  const existing = input.existingClipPath?.trim() ?? "";
  if (existing) return existing;

  const videoUrl = input.videoUrl?.trim() ?? "";
  if (!videoUrl) {
    throw new ClipStoreError("Motion completed without a video URL, so the clip was not copied.", false);
  }

  const { bytes, contentType } = await downloadClipBytes(
    videoUrl,
    input.fetchImpl,
    input.timeoutMs ?? CLIP_DOWNLOAD_TIMEOUT_MS,
  );
  const storagePath = clipStoragePath(input.clientId, input.frameId);
  const bucket = sb.storage.from(CLIENT_MEDIA_BUCKET);
  const uploaded = await bucket.upload(storagePath, bytes, { contentType, upsert: false });
  if (uploaded.error) {
    const uploadError = uploaded.error as { message: string; statusCode?: string | number };
    if (isDuplicate(uploadError)) {
      throw new ClipStoreError(`Clip already exists at ${storagePath}. It was not overwritten.`, false);
    }
    const removed = await bucket.remove([storagePath]);
    const orphan = removed.error
      ? ` The uploaded object could not be removed (${removed.error.message}).`
      : " The uploaded object was removed.";
    throw new ClipStoreError(`Could not store the clip: ${uploadError.message}.${orphan}`, true);
  }

  const written = await sb.from("client_media_frames").update({ clip_path: storagePath }).eq("id", input.frameId);
  if (written.error) {
    const removed = await bucket.remove([storagePath]);
    const orphan = removed.error
      ? ` The uploaded object could not be removed (${removed.error.message}).`
      : " The uploaded object was removed.";
    throw new ClipStoreError(`Could not record clip_path: ${written.error.message}.${orphan}`, true);
  }
  return storagePath;
}
