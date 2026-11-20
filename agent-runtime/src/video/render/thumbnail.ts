import { createHash } from "node:crypto";
import type { AwsRegion } from "@remotion/lambda";
import { renderStillOnLambda } from "@remotion/lambda/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import type { RuntimeConfig } from "../../config.js";
import { buildVideoRenderInputs } from "./inputs.js";
import { verifyRemoteBytes } from "./candidate.js";

const BUCKET = "client-media";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;

type Identity = { client_id: string; project_id: string;
  attempt_id: string; ir_version: number; storage_path: string;
  object_id: string; object_version: string | null;
  object_updated_at: string };
type Receipt = { id: string; client_id: string; project_id: string;
  ir_version: number; storage_path: string;
  object_id: string; object_version: string | null;
  object_updated_at: string; job_id: string;
  first_candidate_id: string; state: string; file_sha256: string;
  file_bytes: number; provider_render_id: string; provider_usd: number };
type Dependencies = { prepare: typeof buildVideoRenderInputs;
  still: typeof renderStillOnLambda; download: typeof fetch;
  verifyRemote: typeof verifyRemoteBytes };
const defaults: Dependencies = { prepare: buildVideoRenderInputs,
  still: renderStillOnLambda, download: fetch,
  verifyRemote: verifyRemoteBytes };

export class ThumbnailOutcomeHeldError extends Error {}

function identity(value: unknown, expected: { clientId: string;
  projectId: string; attemptId: string; irVersion: number;
  storagePath: string }): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Thumbnail Storage identity is unavailable.");
  }
  const row = value as Record<string, unknown>;
  if (row.client_id !== expected.clientId
    || row.project_id !== expected.projectId
    || row.attempt_id !== expected.attemptId
    || row.ir_version !== expected.irVersion
    || row.storage_path !== expected.storagePath
    || typeof row.object_id !== "string" || !UUID.test(row.object_id)
    || (row.object_version !== null && typeof row.object_version !== "string")
    || typeof row.object_updated_at !== "string"
    || Number.isNaN(Date.parse(row.object_updated_at))) {
    throw new Error("Thumbnail Storage identity differs from the claimed attempt.");
  }
  return row as Identity;
}

async function boundedJpeg(response: Response, expectedBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body
    || !Number.isSafeInteger(expectedBytes)
    || expectedBytes <= 100 || expectedBytes > MAX_BYTES) {
    throw new Error("Thumbnail provider bytes are unavailable or oversized.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes || size > MAX_BYTES) {
        throw new Error("Thumbnail exceeded its provider byte receipt.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (size !== expectedBytes || bytes[0] !== 0xff
    || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff
    || bytes.at(-1) !== 0xd9) {
    throw new Error("Thumbnail JPEG differs from provider evidence.");
  }
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "jpeg"
    || metadata.width !== 1280 || metadata.height !== 720) {
    throw new Error("Thumbnail JPEG dimensions differ from the composition.");
  }
  return bytes;
}

async function filedReceipt(input: { sb: SupabaseClient;
  clientId: string; projectId: string; jobId: string;
  firstCandidateId: string; irVersion: number; attemptId: string;
  verifyRemote: typeof verifyRemoteBytes }): Promise<string> {
  const queried = await input.sb.from("video_project_thumbnail_attempts_v1")
    .select("*").eq("id", input.attemptId)
    .eq("client_id", input.clientId).maybeSingle();
  const row = queried.data as Receipt | null;
  if (queried.error || !row || row.state !== "filed"
    || row.id !== input.attemptId || row.project_id !== input.projectId
    || row.ir_version !== input.irVersion || row.job_id !== input.jobId
    || row.first_candidate_id !== input.firstCandidateId
    || !row.storage_path || !HASH.test(row.file_sha256)
    || !Number.isSafeInteger(row.file_bytes)
    || row.file_bytes <= 100 || row.file_bytes > MAX_BYTES
    || !UUID.test(row.object_id)
    || !row.object_updated_at
    || Number.isNaN(Date.parse(row.object_updated_at))) {
    throw new ThumbnailOutcomeHeldError(
      "Filed thumbnail receipt differs from the exact video project.");
  }
  const replay = await input.sb.rpc("file_video_project_thumbnail_v1", {
    p_attempt_id: row.id, p_job_id: input.jobId,
    p_storage_path: row.storage_path,
    p_file_sha256: row.file_sha256, p_file_bytes: row.file_bytes,
    p_object_id: row.object_id, p_object_version: row.object_version,
    p_object_updated_at: row.object_updated_at,
    p_width: 1280, p_height: 720,
  });
  if (replay.error || replay.data !== row.id) {
    throw new ThumbnailOutcomeHeldError(
      "Filed thumbnail Storage identity or source changed.");
  }
  await input.verifyRemote({ sb: input.sb,
    storagePath: row.storage_path, sha256: row.file_sha256,
    size: row.file_bytes });
  return row.id;
}

/** A claimed still is never auto-rendered twice. Provider output is costed
 * before download and can become an exact Storage receipt only after byte
 * read-back and a second object-identity read. Any unknown outcome holds.
 */
export async function renderAndFileProjectThumbnail(input: {
  sb: SupabaseClient; config: RuntimeConfig;
  clientId: string; projectId: string; jobId: string;
  irVersion: number; firstCandidateId: string;
  region: AwsRegion; functionName: string; serveUrl: string;
  maxAlignmentLoss: number;
}, deps: Dependencies = defaults): Promise<string> {
  if (![input.clientId,input.projectId,input.jobId,input.firstCandidateId]
      .every((id) => UUID.test(id))
    || !Number.isInteger(input.irVersion) || input.irVersion < 1
    || !/^[a-z]{2}(?:-[a-z]+)+-[1-9]$/.test(input.region)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.functionName)
    || !input.serveUrl.startsWith("https://")) {
    throw new ThumbnailOutcomeHeldError("Thumbnail lacks exact deployment identity.");
  }
  try {
    const site = new URL(input.serveUrl);
    if (!site.hostname || site.username || site.password) throw new Error();
  } catch {
    throw new ThumbnailOutcomeHeldError("Thumbnail renderer site is invalid.");
  }
  let prepared: Awaited<ReturnType<typeof buildVideoRenderInputs>>;
  try {
    prepared = await deps.prepare({ sb: input.sb,
      clientId: input.clientId, projectId: input.projectId,
      maxAlignmentLoss: input.maxAlignmentLoss });
  } catch {
    throw new ThumbnailOutcomeHeldError(
      "Thumbnail source, brand or audio preflight is no longer current.");
  }
  if (prepared.irVersion !== input.irVersion) {
    throw new ThumbnailOutcomeHeldError("Thumbnail source changed before render.");
  }
  const claim = await input.sb.rpc("claim_video_project_thumbnail_v1", {
    p_project_id: input.projectId,p_job_id: input.jobId,
    p_ir_version: input.irVersion,
    p_first_candidate_id: input.firstCandidateId,
  });
  const claimed = claim.data as { state?: string; attempt_id?: string } | null;
  if (claim.error || !claimed?.attempt_id || !UUID.test(claimed.attempt_id)) {
    throw new ThumbnailOutcomeHeldError(
      "Thumbnail claim is unavailable for the accepted project.");
  }
  if (claimed.state === "already_filed") {
    return filedReceipt({ sb: input.sb, clientId: input.clientId,
      projectId: input.projectId, jobId: input.jobId,
      firstCandidateId: input.firstCandidateId,
      irVersion: input.irVersion, attemptId: claimed.attempt_id,
      verifyRemote: deps.verifyRemote });
  }
  if (claimed.state !== "claimed") {
    throw new ThumbnailOutcomeHeldError(
      `Thumbnail attempt is ${claimed.state ?? "unknown"}; reconcile before another paid render.`);
  }
  try {
    const result = await deps.still({ region: input.region,
      functionName: input.functionName, serveUrl: input.serveUrl,
      composition: "VideoThumbnail",
      inputProps: { ir: prepared.ir,
        brandSnapshot: prepared.brandSnapshot },
      frame: 0, imageFormat: "jpeg", privacy: "private",
      forceWidth: 1280, maxRetries: 0,
      outName: `${input.projectId}-v${input.irVersion}`
        + `-${claimed.attempt_id}-thumbnail.jpg`,
    });
    const url = new URL(result.url);
    const price = result.estimatedPrice;
    if (url.protocol !== "https:" || !url.hostname
      || url.username || url.password
      || !Number.isSafeInteger(result.sizeInBytes)
      || result.sizeInBytes <= 100 || result.sizeInBytes > MAX_BYTES
      || !result.renderId || !/^[A-Za-z0-9-]{1,128}$/.test(result.renderId)
      || price.currency !== "USD"
      || !Number.isFinite(price.accruedSoFar)
      || price.accruedSoFar < 0) {
      throw new Error("Thumbnail provider response is invalid.");
    }
    const cost = await input.sb.rpc("record_video_project_thumbnail_provider_v1", {
      p_attempt_id: claimed.attempt_id,p_job_id: input.jobId,
      p_render_id: result.renderId,p_usd: price.accruedSoFar,
    });
    if (cost.error || !cost.data) {
      throw new Error("Thumbnail provider cost could not be filed.");
    }
    const response = await deps.download(url.toString(),
      { signal: AbortSignal.timeout(90_000) });
    const bytes = await boundedJpeg(response,result.sizeInBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = `${input.clientId}/video/projects/${input.projectId}`
      + `/ir-v${input.irVersion}/thumbnail-${claimed.attempt_id}`
      + `-${sha256}.jpg`;
    // A failed no-overwrite upload may mean that a previous response already
    // completed. The independent identity and byte reads decide the outcome.
    await input.sb.storage.from(BUCKET).upload(path,bytes, {
      contentType: "image/jpeg",upsert: false,cacheControl: "0",
    }).catch(() => undefined);
    const expected = { clientId: input.clientId,
      projectId: input.projectId,attemptId: claimed.attempt_id,
      irVersion: input.irVersion,storagePath: path };
    const first = await input.sb.rpc(
      "video_project_thumbnail_storage_identity_v1", {
        p_attempt_id: claimed.attempt_id,p_file_sha256: sha256 });
    if (first.error) throw new Error("Thumbnail Storage identity is unavailable.");
    const before = identity(first.data,expected);
    await deps.verifyRemote({ sb: input.sb, storagePath: path,
      sha256,size: bytes.length });
    const second = await input.sb.rpc(
      "video_project_thumbnail_storage_identity_v1", {
        p_attempt_id: claimed.attempt_id,p_file_sha256: sha256 });
    if (second.error) throw new Error("Thumbnail Storage identity changed.");
    const after = identity(second.data,expected);
    if (before.object_id !== after.object_id
      || before.object_version !== after.object_version
      || before.object_updated_at !== after.object_updated_at) {
      throw new Error("Thumbnail Storage object changed during read-back.");
    }
    const filed = await input.sb.rpc("file_video_project_thumbnail_v1", {
      p_attempt_id: claimed.attempt_id,p_job_id: input.jobId,
      p_storage_path: path,p_file_sha256: sha256,
      p_file_bytes: bytes.length,p_object_id: before.object_id,
      p_object_version: before.object_version,
      p_object_updated_at: before.object_updated_at,
      p_width: 1280,p_height: 720,
    });
    if (filed.error || filed.data !== claimed.attempt_id) {
      throw new Error("Verified thumbnail could not be filed.");
    }
    return filed.data;
  } catch {
    await input.sb.rpc("mark_video_project_thumbnail_uncertain_v1", {
      p_attempt_id: claimed.attempt_id,p_job_id: input.jobId,
      p_code: "provider_or_storage_unknown",
    });
    throw new ThumbnailOutcomeHeldError(
      "Thumbnail paid or Storage outcome is uncertain; reconcile its exact attempt before retrying.");
  }
}
