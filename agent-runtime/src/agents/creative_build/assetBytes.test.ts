import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerStoredAssetBytes } from "./assetBytes.js";

const fixture = fileURLToPath(new URL("./fixtures/light-objects.png", import.meta.url));

function client(stored: Buffer | null, rpcError: string | null = null) {
  const rpc = vi.fn().mockResolvedValue({ error: rpcError ? { message: rpcError } : null });
  const download = vi.fn().mockResolvedValue({
    data: stored ? new Blob([new Uint8Array(stored)]) : null,
    error: stored ? null : { message: "missing" },
  });
  const sb = { storage: { from: () => ({ download }) }, rpc } as unknown as SupabaseClient;
  return { sb, rpc, download };
}

describe("generated asset byte evidence", () => {
  it("registers the hash of a real stored image only after matching read-back", async () => {
    const bytes = await readFile(fixture);
    const { sb, rpc, download } = client(bytes);
    const digest = await registerStoredAssetBytes(sb, "client-media", "asset-1", "client/generated/render.png", bytes);
    expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(download).toHaveBeenCalledWith("client/generated/render.png");
    expect(rpc).toHaveBeenCalledWith("register_delivery_asset_bytes_v6", {
      p_asset_id: "asset-1", p_storage_path: "client/generated/render.png", p_sha256: digest,
    });
  });

  it("refuses a changed or missing Storage object before registering review evidence", async () => {
    const bytes = await readFile(fixture);
    for (const stored of [Buffer.from("different"), null]) {
      const { sb, rpc } = client(stored);
      await expect(registerStoredAssetBytes(sb, "client-media", "asset-1", "path.png", bytes)).rejects.toThrow();
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("refuses to finish when the trusted registration fails", async () => {
    const bytes = await readFile(fixture);
    const { sb } = client(bytes, "path is stale");
    await expect(registerStoredAssetBytes(sb, "client-media", "asset-1", "path.png", bytes))
      .rejects.toThrow("Could not register asset byte evidence: path is stale");
  });
});
