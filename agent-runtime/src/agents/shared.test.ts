import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUpstreamRecords, persistRecords, renderContext } from "./shared.js";

describe("current Intelligence context", () => {
  it("labels the source date so historical launch status is not presented as current", () => {
    const rendered = renderContext({
      updated_at: "2026-09-25T00:00:00Z", business_overview: "Launch planned for October",
      ideal_customer: "Two-crew owner", main_offer: null,
      competitors: "Lead marketplaces", brand_voice: null,
      proof_testimonials: null, current_marketing: null, sales_process: null,
      current_revenue: null, target_revenue: null,
    });
    expect(rendered).toContain("Business context last updated (historical source date): 2026-09-25T00:00:00Z");
    expect(rendered).toContain("Intended target customer (operator hypothesis, not observed buyer research): Two-crew owner");
    expect(rendered).toContain("Competitors in the operator's analysis (not evidence that buyers use them): Lead marketplaces");
  });

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
      is: vi.fn().mockReturnThis(),
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
    expect(query.is).toHaveBeenCalledWith("period", null);
    expect(query.upsert).not.toHaveBeenCalled();
  });

  it("scopes human edits and archive checks to the campaign intelligence period", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
    };
    const sb = { from: vi.fn().mockReturnValue(query) } as unknown as SupabaseClient;
    const result = await persistRecords(sb, {
      clientId: "client-1", domain: "campaign_intelligence", jobId: "job-2", period: "2026-Q2",
      templates: [{ item_key: "decision", item_type: "section", title: "Decision", description: "", display_order: 1 }],
      sections: { decision: "Demand exceeds supply." },
    });
    expect(query.eq).toHaveBeenCalledWith("period", "2026-Q2");
    expect(result.written).toBe(1);
  });
});
