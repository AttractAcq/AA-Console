/**
 * Freezes the bytes that an organic publisher might later use.
 *
 * This worker cannot publish. Migration 292 registers only held Inbox cards;
 * a later source-owned AAL2 decision and provider prewrite gate are required
 * before any package can be sent. The byte digest comes from a downloaded
 * object, never from a path or Storage metadata. The private destination is
 * content-addressed and an SQL trigger refuses replacing its bytes.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentRow } from "../../orchestration/registry.js";
import type { JobResult } from "../../orchestration/dispatch.js";
import type { AgentJobRow } from "../../queue.js";
import { appendEvent } from "../../queue.js";
import { isPlatform, type Platform } from "../../content/platform-limits.js";
import { compose, type CopyRow } from "../../publishing/caption.js";

const SOURCE_BUCKET = "client-media";
const FROZEN_BUCKET = "publication-media";
const MAX_BYTES = 524_288_000;

interface Candidate {
  post_id: string;
  client_id: string;
  platform: Platform;
  copy: CopyRow;
  source_paths: string[];
  source_snapshot_hash: string;
}

export interface FrozenMedia {
  source_path: string;
  frozen_bucket: typeof FROZEN_BUCKET;
  frozen_path: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadBytes(
  sb: SupabaseClient,
  bucket: string,
  path: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`Could not download ${bucket} object ${path}: ${error?.message ?? "missing file"}`);
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new Error(`Media at ${path} has an unsupported byte length.`);
  }
  return { bytes, mime: data.type.trim().toLowerCase() };
}

/** Freeze one source object and verify the bytes through a second download. */
export async function freezeOrganicMedia(
  sb: SupabaseClient,
  clientId: string,
  sourcePath: string,
): Promise<FrozenMedia> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(clientId) ||
      !sourcePath.startsWith(`${clientId}/`) || sourcePath.includes("..")) {
    throw new Error("The organic media source is not a valid client object path.");
  }
  const { bytes, mime } = await downloadBytes(sb, SOURCE_BUCKET, sourcePath);
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
    throw new Error(`The media at ${sourcePath} has no trusted MIME type.`);
  }
  const sha256 = digest(bytes);
  const frozenPath = `${clientId}/${sha256}`;
  const { error: uploadError } = await sb.storage.from(FROZEN_BUCKET).upload(
    frozenPath,
    bytes,
    { contentType: mime, upsert: false },
  );
  // An earlier sweep may already have uploaded this content-addressed path.
  // Even on a collision, the second download must prove that it is the same
  // object before its address can be entered into an approval package.
  const frozen = await downloadBytes(sb, FROZEN_BUCKET, frozenPath).catch((error: unknown) => {
    throw new Error(
      `Frozen media is unavailable after upload: ${uploadError?.message ?? String(error)}`,
    );
  });
  if (digest(frozen.bytes) !== sha256 || frozen.bytes.length !== bytes.length ||
      frozen.mime !== mime) {
    throw new Error(`Frozen media at ${frozenPath} differs from its source bytes.`);
  }
  return {
    source_path: sourcePath,
    frozen_bucket: FROZEN_BUCKET,
    frozen_path: frozenPath,
    sha256,
    byte_size: bytes.length,
    mime_type: mime,
  };
}

function candidateOf(raw: unknown): Candidate {
  if (!raw || typeof raw !== "object") throw new Error("Publication candidate is malformed.");
  const row = raw as Record<string, unknown>;
  if (typeof row.post_id !== "string" || typeof row.client_id !== "string" ||
      typeof row.platform !== "string" || !isPlatform(row.platform) ||
      !row.copy || typeof row.copy !== "object" || Array.isArray(row.copy) ||
      typeof (row.copy as Record<string, unknown>).caption !== "string" ||
      typeof row.source_snapshot_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.source_snapshot_hash) ||
      !Array.isArray(row.source_paths) || row.source_paths.length < 1 ||
      row.source_paths.length > 10 ||
      !row.source_paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new Error("Publication candidate lacks exact media paths or source hash.");
  }
  return row as unknown as Candidate;
}

export async function runOrganicPackageBuilderJob(
  sb: SupabaseClient,
  _runtime: unknown,
  _agent: AgentRow,
  job: AgentJobRow,
): Promise<JobResult> {
  const requested = Number((job.params as Record<string, unknown> | null)?.limit ?? 5);
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 50 ? requested : 5;
  const { data, error } = await sb.rpc("organic_publication_package_candidates_v6", {
    p_limit: limit,
  } as never);
  if (error) throw new Error(`Could not read organic package candidates: ${error.message}`);
  let frozen = 0;
  let failed = 0;
  for (const raw of data ?? []) {
    try {
      const candidate = candidateOf(raw);
      const composed = compose(candidate.platform, candidate.copy);
      const media: FrozenMedia[] = [];
      for (const path of candidate.source_paths) {
        media.push(await freezeOrganicMedia(sb, candidate.client_id, path));
      }
      const { error: registerError } = await sb.rpc("register_organic_publication_package_v6", {
        p_post_id: candidate.post_id,
        p_expected_source_hash: candidate.source_snapshot_hash,
        p_media: media,
        p_provider_copy: {
          caption: composed.caption,
          first_comment: composed.firstComment,
        },
      } as never);
      if (registerError) throw new Error(registerError.message);
      frozen += 1;
      await appendEvent(sb, job.id,
        "Frozen one exact organic media-byte package; Approval Inbox holds its publication decision.",
        "info", { post_id: candidate.post_id });
    } catch (reason) {
      failed += 1;
      await appendEvent(sb, job.id,
        `Could not freeze an organic publication package: ${reason instanceof Error ? reason.message : String(reason)}`,
        "error");
    }
  }
  return {
    ok: failed === 0,
    retryable: failed > 0,
    ...(failed > 0 ? { failureMessage: `${failed} organic package candidate(s) failed; ${frozen} froze.` } : {}),
  };
}
