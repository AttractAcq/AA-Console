import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCampaignBriefContext } from "./campaign-context.js";

function source(overrides: Record<string, unknown> = {}) {
  const campaign = { id: "campaign-1", client_id: "client-1", campaign_kind: "opportunity_campaign",
    name: "Focused campaign", brief: "Reach buyers with a clear buying trigger",
    audience: "Local service buyers", objective: "Book consultations", core_message: "Explain the service",
    offer_summary: "Approved consultation", channels: ["instagram"], acquisition_mode: "both",
    paid_platform: "meta", offer_version_id: "offer-1", plan_approved_at: "2026-11-20T00:00:00Z",
    plan_approved_fingerprint: "plan-hash-1", ...overrides };
  const records: Record<string, Record<string, unknown>> = {
    client_campaigns: campaign,
    opportunity_links: { client_id: "client-1", opportunity_id: "opportunity-1" },
    market_opportunities: { id: "opportunity-1", client_id: "client-1", name: "Urgent repair", status: "approved",
      micro_market: "Households with failed systems", buying_situation: "A system has stopped working",
      core_problem: "No service", desired_outcome: "Restored service", positioning: "Fast diagnosis",
      purchase_trigger: "Recent failure", approved_content_hash: "opportunity-hash-1" },
  };
  const from = vi.fn((table: string) => {
    const chain = { select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: records[table] ?? null, error: null }) };
    return chain;
  });
  const rpc = vi.fn(async () => ({ data: { id: "offer-1", version: 3, promise: "A verified service promise",
    price_amount: 100, content_hash: "offer-hash-1" }, error: null }));
  return { sb: { from, rpc } as unknown as SupabaseClient, from, rpc, records };
}

describe("campaign brief source", () => {
  it("keeps standalone manual ideas on their existing brief path", async () => {
    const db = source();
    expect(await loadCampaignBriefContext(db.sb, "client-1", null)).toEqual({ text: "", blocker: null });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("includes the exact approved plan, offer and client-owned opportunity", async () => {
    const db = source();
    const result = await loadCampaignBriefContext(db.sb, "client-1", "campaign-1");
    expect(result.blocker).toBeNull();
    expect(result.text).toContain("plan-hash-1");
    expect(result.text).toContain("A verified service promise");
    expect(result.text).toContain("A system has stopped working");
    expect(db.rpc).toHaveBeenCalledWith("capture_campaign_offer_v6", { p_campaign_id: "campaign-1" });
  });

  it("holds unapproved plans, wrong-client campaigns and missing opportunity links", async () => {
    const unapproved = source({ plan_approved_at: null });
    expect((await loadCampaignBriefContext(unapproved.sb, "client-1", "campaign-1")).blocker)
      .toMatch(/not approved/);
    expect(unapproved.rpc).not.toHaveBeenCalled();

    const wrongClient = source({ client_id: "client-2" });
    expect((await loadCampaignBriefContext(wrongClient.sb, "client-1", "campaign-1")).blocker)
      .toMatch(/another client/);

    const missingLink = source();
    delete missingLink.records.opportunity_links;
    expect((await loadCampaignBriefContext(missingLink.sb, "client-1", "campaign-1")).blocker)
      .toMatch(/no valid client-owned/);

    const revokedOpportunity = source();
    revokedOpportunity.records.market_opportunities!.status = "rejected";
    expect((await loadCampaignBriefContext(revokedOpportunity.sb, "client-1", "campaign-1")).blocker)
      .toMatch(/no longer has a current approval/);
  });

  it("allows standalone paid without an offer and refuses a mismatched offer", async () => {
    const standalone = source({ campaign_kind: "standalone_paid", offer_version_id: null });
    const result = await loadCampaignBriefContext(standalone.sb, "client-1", "campaign-1");
    expect(result.blocker).toBeNull();
    expect(result.text).toContain("Do not invent an offer or price");
    expect(standalone.rpc).not.toHaveBeenCalled();

    const mismatch = source();
    mismatch.rpc.mockResolvedValueOnce({ data: { id: "offer-2", version: 3,
      promise: "Another offer", price_amount: 100, content_hash: "other-hash" }, error: null });
    expect((await loadCampaignBriefContext(mismatch.sb, "client-1", "campaign-1")).blocker)
      .toMatch(/exact campaign offer version/);
  });
});
