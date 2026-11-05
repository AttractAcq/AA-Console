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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRIVATE_OBJECT_CACHE_CONTROL_SECONDS } from "../../storage/signed-url-policy.js";
import {
  generatedClipProblem,
  probeGeneratedClip,
  type GeneratedClipProbe,
} from "./screen.js";

/**
 * Measure the downloaded bytes before they are stored.
 *
 * Injectable because the real one shells out to ffprobe and ffmpeg, which a
 * unit test has no business doing against fabricated bytes. Production gets
 * the real probe by default; a test opts into a stub and says so.
 */
export type ClipProbe = (path: string) => Promise<GeneratedClipProbe>;

/**
 * Refuse a clip with no shot in it, before it is stored.
 *
 * A refusal is NOT retryable. The provider has already rendered and charged
 * for this request, and re-running the job would poll the same request and
 * download the same broken bytes. Regenerating is a separate, deliberate act
 * with its own single-retry budget -- `provider_retry_count` is capped at one
 * and `retry_failed_higgsfield_motion_step` is how it is spent. So this does
 * what every other provider problem in this agent does: stops, says exactly
 * what was measured, and leaves `clip_path` null, which is the state that
 * recovery path looks for.
 */
async function screenClipBytes(bytes: Buffer, probe: ClipProbe): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aa-clip-screen-"));
  const path = join(dir, "clip.mp4");
  try {
    await writeFile(path, bytes);
    let measured: GeneratedClipProbe;
    try {
      measured = await probe(path);
    } catch (caught) {
      // A clip ffprobe cannot read is not a shot, and saying so beats storing
      // bytes nothing could decode.
      const detail = caught instanceof Error ? caught.name : "Error";
      throw new ClipStoreError(
        `The generated clip could not be inspected (${detail}), so it was not stored.`,
        false,
        UNUSABLE_CLIP_REASON,
      );
    }
    const problem = generatedClipProblem(measured);
    if (problem) {
      throw new ClipStoreError(`${problem} It was not stored and was not submitted again.`, false, UNUSABLE_CLIP_REASON);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Same bucket creative_build writes stills to. */
export const CLIENT_MEDIA_BUCKET = "client-media";

/** Cockpit check-shot-generation uses about two minutes for the download. */
export const CLIP_DOWNLOAD_TIMEOUT_MS = 120_000;

export class ClipStoreError extends Error {
  readonly retryable: boolean;
  /** Event-log slug, when this is something more specific than a store failure. */
  readonly reason: string | undefined;

  constructor(message: string, retryable: boolean, reason?: string) {
    super(message);
    this.name = "ClipStoreError";
    this.retryable = retryable;
    this.reason = reason;
  }
}

/** The slug a clip refused by the screen carries into the job's event log. */
export const UNUSABLE_CLIP_REASON = "generated_clip_unusable";

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
    /** Defaults to the real ffprobe/ffmpeg screen; tests pass a stub. */
    probeImpl?: ClipProbe;
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
  await screenClipBytes(bytes, input.probeImpl ?? probeGeneratedClip);

  const storagePath = clipStoragePath(input.clientId, input.frameId);
  const bucket = sb.storage.from(CLIENT_MEDIA_BUCKET);
  const uploaded = await bucket.upload(storagePath, bytes, {
    contentType, upsert: false, cacheControl: PRIVATE_OBJECT_CACHE_CONTROL_SECONDS,
  });
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
