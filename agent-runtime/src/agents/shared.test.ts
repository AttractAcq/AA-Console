import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUpstreamRecords, persistRecords } from "./shared.js";

describe("current Intelligence context", () => {
  it("excludes archived records before feeding another agent", async () => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
      order: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => void) => resolve({ data: [{ domain: "icp", item_key: "question-universe", title: "Questions", body: "What will this cost?" }], error: null }),
    };
    const sb = { from: vi.fn().mockReturnValue(query) } as unknown as SupabaseClient;
    const records = await loadUpstreamRecords(sb, "client-1", ["icp"]);
    expect(filters).toContainEqual(["archived_at", null]);
    expect(records).toHaveLength(1);
  });

  it("refuses to rewrite an archived template record on a rerun", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      upsert: vi.fn(),
      then: (resolve: (value: unknown) => void) => resolve({
        data: [{ item_key: "question-universe", edited_at: null, archived_at: "2026-11-01T00:00:00Z" }],
        error: null,
      }),
    };
    const sb = { from: vi.fn().mockReturnValue(query) } as unknown as SupabaseClient;
    await expect(persistRecords(sb, {
      clientId: "client-1", domain: "icp", jobId: "job-1", period: null,
      templates: [{ item_key: "question-universe", item_type: "section", title: "Questions", description: "", display_order: 1 }],
      sections: { "question-universe": "What will this cost?" },
    })).rejects.toThrow(/archived/);
    expect(query.upsert).not.toHaveBeenCalled();
  });
});
