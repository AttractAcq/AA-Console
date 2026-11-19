import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { verifyFrozenPublicationPackage } from "./frozen-package.js";

const expected = {
  clientId: "client-1",
  postId: "post-1",
  platform: "instagram",
  scheduledAt: "2026-11-19T09:00:00Z",
};
const bytes = Buffer.from("reviewed image bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const sourcePath = "client-1/source.png";
const frozenPath = `client-1/${digest}`;

function packet() {
  return {
    artifact_hash: "a".repeat(64),
    manifest: {
      client_id: expected.clientId,
      scheduled_post_id: expected.postId,
      platform: expected.platform,
      account_ref: "instagram-account-1",
      scheduled_at: expected.scheduledAt,
      content_format: "single",
      media_type: "image",
      rights: { usage_rights: "client_owned" },
      source_paths: [sourcePath],
      copy: { alt_text: "A reviewed image" },
      provider_copy: { caption: "Reviewed words", first_comment: null },
      media: [{
        frozen_bucket: "publication-media",
        frozen_path: frozenPath,
        source_path: sourcePath,
        sha256: digest,
        byte_size: bytes.length,
        mime_type: "image/png",
      }],
    },
  };
}

function storage(data = bytes) {
  const download = vi.fn(async () => ({ data: new Blob([data], { type: "image/png" }), error: null }));
  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: "https://storage.example/reviewed-image" }, error: null,
  }));
  const from = vi.fn(() => ({ download, createSignedUrl }));
  return { sb: { storage: { from } } as unknown as SupabaseClient,
    from, download, createSignedUrl };
}

describe("frozen publication package", () => {
  it("uses only the reviewed frozen bytes and path", async () => {
    const db = storage();
    const result = await verifyFrozenPublicationPackage(db.sb, packet(), expected);
    expect(result).toMatchObject({
      artifactHash: "a".repeat(64), accountRef: "instagram-account-1",
      caption: "Reviewed words", mediaUrls: ["https://storage.example/reviewed-image"],
    });
    expect(db.from).toHaveBeenCalledWith("publication-media");
    expect(db.download).toHaveBeenCalledWith(frozenPath);
    expect(db.createSignedUrl).toHaveBeenCalledWith(frozenPath, expect.any(Number));
  });

  it("rejects a package bound to another post before Storage access", async () => {
    const db = storage();
    const raw = packet();
    raw.manifest.scheduled_post_id = "post-2";
    await expect(verifyFrozenPublicationPackage(db.sb, raw, expected)).rejects.toThrow("does not match");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("rejects changed frozen bytes before signing them", async () => {
    const db = storage(Buffer.from("changed bytes"));
    await expect(verifyFrozenPublicationPackage(db.sb, packet(), expected)).rejects.toThrow("bytes changed");
    expect(db.createSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects missing rights and changed frame order before Storage access", async () => {
    const db = storage();
    const rightsFree = packet();
    rightsFree.manifest.rights.usage_rights = "unknown";
    await expect(verifyFrozenPublicationPackage(db.sb, rightsFree, expected)).rejects.toThrow("does not match");
    const reordered = packet();
    reordered.manifest.source_paths = ["client-1/another.png"];
    await expect(verifyFrozenPublicationPackage(db.sb, reordered, expected)).rejects.toThrow("order differs");
    expect(db.from).not.toHaveBeenCalled();
  });
});
