import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { reusableGeneratedAsset } from "./generatedAsset.js";

function client(rows: Array<Record<string, unknown>>) {
  const query = {
    select: () => query,
    eq: () => query,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => query } as unknown as SupabaseClient;
}

const pending = { id: "asset-1", brief_id: "brief-1", media_type: "image",
  review_status: "pending", human_approved_at: null, archived_at: null };
const find = (sb: SupabaseClient) => reusableGeneratedAsset(sb, "client-1", "brief-1", "render.png", "image");

describe("generated asset retry", () => {
  it("reuses the sole pending record after a partial producer failure", async () => {
    expect(await find(client([pending]))).toBe("asset-1");
    expect(await find(client([]))).toBeNull();
  });

  it("refuses to overwrite reviewed, archived, wrong-brief or duplicate records", async () => {
    for (const rows of [
      [{ ...pending, review_status: "approved" }],
      [{ ...pending, human_approved_at: "2026-11-20T00:00:00Z" }],
      [{ ...pending, archived_at: "2026-11-20T00:00:00Z" }],
      [{ ...pending, brief_id: "other-brief" }],
      [pending, { ...pending, id: "asset-2" }],
    ]) {
      await expect(find(client(rows))).rejects.toThrow();
    }
  });
});
