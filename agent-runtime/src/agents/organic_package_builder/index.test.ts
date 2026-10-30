import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { freezeOrganicMedia, runOrganicPackageBuilderJob } from "./index.js";
import type { AgentJobRow } from "../../queue.js";
import type { AgentRow } from "../../orchestration/registry.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const SOURCE = `${CLIENT}/generated/asset.png`;
const BYTES = Buffer.from("the exact image bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function storageFixture(overwrite = false) {
  const objects = new Map<string, { bytes: Buffer; mime: string }>([
    [`client-media:${SOURCE}`, { bytes: BYTES, mime: "image/png" }],
  ]);
  const upload = vi.fn(async (path: string, data: Buffer, options: { contentType: string; upsert: boolean }) => {
    expect(options.upsert).toBe(false);
    objects.set(`publication-media:${path}`, {
      bytes: overwrite ? Buffer.from("wrong") : Buffer.from(data),
      mime: options.contentType,
    });
    return { data: { path }, error: null };
  });
  const from = vi.fn((bucket: string) => ({
    download: async (path: string) => {
      const object = objects.get(`${bucket}:${path}`);
      return object
        ? { data: new Blob([new Uint8Array(object.bytes)], { type: object.mime }), error: null }
        : { data: null, error: { message: "not found" } };
    },
    upload,
  }));
  return { sb: { storage: { from } } as unknown as SupabaseClient, upload, objects };
}

describe("organic media byte freezing", () => {
  it("hashes downloaded bytes, writes a private content-addressed path and rechecks the stored bytes", async () => {
    const { sb, upload } = storageFixture();
    const media = await freezeOrganicMedia(sb, CLIENT, SOURCE);
    expect(media).toEqual({
      source_path: SOURCE,
      frozen_bucket: "publication-media",
      frozen_path: `${CLIENT}/${SHA}`,
      sha256: SHA,
      byte_size: BYTES.length,
      mime_type: "image/png",
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("rejects an archive whose bytes differ, without returning a package manifest", async () => {
    const { sb } = storageFixture(true);
    await expect(freezeOrganicMedia(sb, CLIENT, SOURCE)).rejects.toThrow(/differs from its source bytes/);
  });

  it("refuses cross-client and traversing source paths before any Storage access", async () => {
    const { sb, upload } = storageFixture();
    await expect(freezeOrganicMedia(sb, CLIENT, "22222222-2222-4222-8222-222222222222/media.png"))
      .rejects.toThrow(/not a valid client object path/);
    await expect(freezeOrganicMedia(sb, CLIENT, `${CLIENT}/../private.png`))
      .rejects.toThrow(/not a valid client object path/);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("held package sweep", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers only a verified byte package and never reads credentials or calls a provider", async () => {
    const { sb: storageClient } = storageFixture();
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "organic_publication_package_candidates_v6") return {
        data: [{ post_id: "post-1", client_id: CLIENT,
          platform: "instagram", copy: { caption: "The exact caption", hashtags: ["#proof"], link_url: null, first_comment: null },
          source_paths: [SOURCE], source_snapshot_hash: "a".repeat(64) }], error: null,
      };
      if (name === "register_organic_publication_package_v6") {
        expect(args.p_media).toEqual([expect.objectContaining({ sha256: SHA })]);
        expect(args.p_provider_copy).toEqual({ caption: "The exact caption\n\n#proof", first_comment: null });
        return { data: "package-1", error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const from = vi.fn((table: string) => {
      expect(table).toBe("agent_job_events");
      return { insert: async () => ({ error: null }) };
    });
    const sb = { storage: storageClient.storage, rpc, from } as unknown as SupabaseClient;
    const result = await runOrganicPackageBuilderJob(sb, {}, {} as AgentRow,
      { id: "job-1", params: { limit: 1 } } as unknown as AgentJobRow);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "organic_publication_package_candidates_v6",
      "register_organic_publication_package_v6",
    ]);
  });
});
