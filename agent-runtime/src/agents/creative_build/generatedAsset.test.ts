import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { reusableFramedRenderAsset, reusableGeneratedAsset } from "./generatedAsset.js";

function client(rows: Array<Record<string, unknown>>) {
  const query = {
    select: () => query,
    eq: () => query,
    like: () => query,
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

describe("framed render retry", () => {
  const findFramed = (sb: SupabaseClient) => reusableFramedRenderAsset(
    sb, "client-1", "brief-1", "render-1", "image", "carousel",
  );
  const framed = { ...pending, content_format: "carousel" };

  it("reuses only the one pending framed asset at this render path", async () => {
    expect(await findFramed(client([]))).toBeNull();
    expect(await findFramed(client([framed]))).toBe("asset-1");
  });

  it("holds a mismatched, reviewed or ambiguous framed asset", async () => {
    for (const rows of [
      [{ ...framed, content_format: "story" }],
      [{ ...framed, media_type: "video" }],
      [{ ...framed, review_status: "approved" }],
      [{ ...framed, archived_at: "2026-11-20T00:00:00Z" }],
      [framed, { ...framed, id: "asset-2" }],
    ]) {
      await expect(findFramed(client(rows))).rejects.toThrow();
    }
  });
});
