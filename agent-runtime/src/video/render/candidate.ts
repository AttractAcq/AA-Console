import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import type { RuntimeConfig } from "../../config.js";
import type { ProjectRenderProbe, VideoAspect } from "./probe.js";

const BUCKET = "client-media";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 50 * 1024 * 1024 * 1024;

type Identity = { client_id: string; project_id: string;
  attempt_id: string; ir_version: number; aspect: VideoAspect;
  storage_path: string; object_id: string; object_version: string | null;
  object_updated_at: string };
type LocalFile = { size: number; sha256: string; mtimeMs: number; ino: number };
type Dependencies = {
  upload: typeof uploadCandidate;
  verifyRemote: typeof verifyRemoteBytes;
};
const defaults: Dependencies = { upload: uploadCandidate,
  verifyRemote: verifyRemoteBytes };

function storageEndpoint(supabaseUrl: string): string {
  const base = new URL(supabaseUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1"
    && base.hostname !== "localhost") {
    throw new Error("Supabase Storage endpoint must use HTTPS.");
  }
  if (/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname)) {
    base.hostname = base.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  }
  return new URL("/storage/v1/upload/resumable", base).toString();
}

async function localFile(path: string): Promise<LocalFile> {
  const before = await stat(path);
  if (!before.isFile() || before.size <= 100 || before.size > MAX_BYTES) {
    throw new Error("Mastered MP4 has an invalid file size.");
  }
  const digest = createHash("sha256");
  let length = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    length += chunk.length;
  }
  const after = await stat(path);
  if (length !== before.size || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error("Mastered MP4 changed while its digest was measured.");
  }
  return { size: before.size, sha256: digest.digest("hex"),
    mtimeMs: before.mtimeMs, ino: before.ino };
}

/** TUS uses the 6 MB chunk required by Supabase Storage. No upsert is sent:
 * an already completed exact path is verified through read-back instead.
 */
async function uploadCandidate(input: { path: string; storagePath: string;
  supabaseUrl: string; serviceRoleKey: string; sha256: string }): Promise<void> {
  const endpoint = storageEndpoint(input.supabaseUrl);
  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(createReadStream(input.path), {
      endpoint,
      headers: { authorization: `Bearer ${input.serviceRoleKey}`,
        apikey: input.serviceRoleKey },
      metadata: { bucketName: BUCKET, objectName: input.storagePath,
        contentType: "video/mp4", cacheControl: "0" },
      fingerprint: async () => `${endpoint}|${BUCKET}|${input.storagePath}|${input.sha256}`,
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onSuccess: () => resolve(),
      onError: () => reject(new Error("Resumable MP4 Storage upload failed.")),
    });
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]!);
      upload.start();
    }, () => upload.start());
  });
}

export async function verifyRemoteBytes(input: { sb: SupabaseClient;
  storagePath: string; sha256: string; size: number }): Promise<void> {
  const signed = await input.sb.storage.from(BUCKET)
    .createSignedUrl(input.storagePath, 3600);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("Candidate Storage read-back URL is unavailable.");
  }
  const response = await fetch(signed.data.signedUrl,
    { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) {
    throw new Error("Candidate Storage bytes could not be read back.");
  }
  const digest = createHash("sha256");
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      digest.update(value);
      length += value.byteLength;
      if (length > input.size) {
        throw new Error("Candidate Storage file exceeds the local MP4 size.");
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (length !== input.size || digest.digest("hex") !== input.sha256) {
    throw new Error("Candidate Storage bytes differ from the mastered MP4.");
  }
}

function identity(value: unknown, expected: { clientId: string;
  projectId: string; attemptId: string; irVersion: number;
  aspect: VideoAspect; path: string }): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candidate Storage identity is unavailable.");
  }
  const row = value as Record<string, unknown>;
  if (row.client_id !== expected.clientId
    || row.project_id !== expected.projectId
    || row.attempt_id !== expected.attemptId
    || row.ir_version !== expected.irVersion
    || row.aspect !== expected.aspect
    || row.storage_path !== expected.path
    || typeof row.object_id !== "string" || !UUID.test(row.object_id)
    || (row.object_version !== null && typeof row.object_version !== "string")
    || typeof row.object_updated_at !== "string"
    || Number.isNaN(Date.parse(row.object_updated_at))) {
    throw new Error("Candidate Storage identity disagrees with the render attempt.");
  }
  return row as Identity;
}

/** File one exact mastered export. A retry can reconcile an upload that
 * completed before the worker observed its result, without overwriting it.
 */
export async function fileProjectRenderCandidate(input: {
  sb: SupabaseClient; config: Pick<RuntimeConfig,
    "supabaseUrl" | "supabaseServiceRoleKey">;
  clientId: string; projectId: string; jobId: string;
  attemptId: string; irVersion: number; aspect: VideoAspect;
  outputPath: string; probe: ProjectRenderProbe;
}, deps: Dependencies = defaults): Promise<string> {
  if (![input.clientId, input.projectId, input.jobId,
    input.attemptId].every((id) => UUID.test(id))
    || !Number.isInteger(input.irVersion) || input.irVersion < 1
    || !input.outputPath.endsWith(".mp4")
    || !["pass", "fail"].includes(input.probe.result)) {
    throw new Error("Render candidate identity or probe is invalid.");
  }
  const file = await localFile(input.outputPath);
  if (!HASH.test(file.sha256)) throw new Error("MP4 digest is invalid.");
  const path = `${input.clientId}/video/projects/${input.projectId}`
    + `/ir-v${input.irVersion}/candidates/${input.attemptId}`
    + `-${input.aspect.replace(":", "x")}-${file.sha256}.mp4`;
  const existingResult = await input.sb.from("video_project_render_candidates_v1")
    .select("id,project_id,client_id,ir_version,aspect,storage_path,file_sha256,file_bytes,media_probe")
    .eq("attempt_id", input.attemptId).eq("client_id", input.clientId)
    .maybeSingle();
  if (existingResult.error) {
    throw new Error("Prior render candidate receipt could not be checked.");
  }
  const existing = existingResult.data;
  if (existing) {
    if (existing.project_id !== input.projectId
      || existing.ir_version !== input.irVersion
      || existing.aspect !== input.aspect
      || existing.storage_path !== path
      || existing.file_sha256 !== file.sha256
      || existing.file_bytes !== file.size
      || !isDeepStrictEqual(existing.media_probe, input.probe)) {
      throw new Error("Prior render candidate receipt differs from this export.");
    }
    await deps.verifyRemote({ sb: input.sb, storagePath: path,
      sha256: file.sha256, size: file.size });
    return existing.id;
  }
  let uploadFailed = false;
  try {
    await deps.upload({ path: input.outputPath, storagePath: path,
      supabaseUrl: input.config.supabaseUrl,
      serviceRoleKey: input.config.supabaseServiceRoleKey,
      sha256: file.sha256 });
  } catch {
    uploadFailed = true;
    // A prior attempt may already have completed this no-overwrite path.
    // The independent read-back below is mandatory in either case.
  }
  const expected = { clientId: input.clientId, projectId: input.projectId,
    attemptId: input.attemptId, irVersion: input.irVersion,
    aspect: input.aspect, path };
  const firstResult = await input.sb.rpc("video_project_render_candidate_identity_v1", {
    p_attempt_id: input.attemptId, p_file_sha256: file.sha256 });
  if (firstResult.error) {
    throw new Error(uploadFailed
      ? "Resumable upload failed and no exact Storage object was verified."
      : "Candidate Storage identity could not be read.");
  }
  const first = identity(firstResult.data, expected);
  await deps.verifyRemote({ sb: input.sb, storagePath: path,
    sha256: file.sha256, size: file.size });
  const secondResult = await input.sb.rpc("video_project_render_candidate_identity_v1", {
    p_attempt_id: input.attemptId, p_file_sha256: file.sha256 });
  if (secondResult.error) throw new Error("Candidate Storage identity changed.");
  const second = identity(secondResult.data, expected);
  if (first.object_id !== second.object_id
    || first.object_version !== second.object_version
    || first.object_updated_at !== second.object_updated_at) {
    throw new Error("Candidate Storage object changed during byte verification.");
  }
  const after = await stat(input.outputPath);
  if (after.size !== file.size || after.mtimeMs !== file.mtimeMs
    || after.ino !== file.ino) {
    throw new Error("Mastered MP4 changed before its receipt was recorded.");
  }
  const commit = await input.sb.rpc("record_video_project_render_candidate_v1", {
    p_attempt_id: input.attemptId, p_job_id: input.jobId,
    p_storage_path: path, p_file_sha256: file.sha256,
    p_file_bytes: file.size, p_object_id: first.object_id,
    p_object_version: first.object_version,
    p_object_updated_at: first.object_updated_at,
    p_media_probe: input.probe,
  });
  if (commit.error || typeof commit.data !== "string" || !UUID.test(commit.data)) {
    throw new Error("Verified render candidate could not be committed.");
  }
  return commit.data;
}
