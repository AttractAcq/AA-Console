import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: {} as Record<string, { data: unknown[] | null; error: { message: string } | null }>,
  scopes: [] as Array<[string, string, string]>,
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: (_columns: string) => ({
        eq: (column: string, value: string) => {
          fixture.scopes.push([table, column, value]);
          return Promise.resolve(fixture.rows[table]);
        },
      }),
    }),
  },
}));

import { fetchOpportunityOutputs } from "./opportunities";

beforeEach(() => {
  fixture.scopes = [];
  fixture.rows = {
    opportunity_links: {
      data: [
        { opportunity_id: "opp-1", role: "offer", offer_id: "offer-1", campaign_id: null },
        { opportunity_id: "opp-1", role: "campaign", offer_id: null, campaign_id: "campaign-1" },
      ],
      error: null,
    },
    service_offers: {
      data: [{ id: "offer-1", service_name: "Garage Refit", kind: "secondary" }],
      error: null,
    },
    client_campaigns: {
      data: [{ id: "campaign-1", name: "Winter Refit", status: "planning", archived_at: null }],
      error: null,
    },
  };
});

describe("opportunity linked work", () => {
  it("joins client-scoped offer and campaign references", async () => {
    const outputs = await fetchOpportunityOutputs("client-1");
    expect(outputs.get("opp-1")).toEqual({
      offers: [{ id: "offer-1", name: "Garage Refit", kind: "secondary" }],
      campaigns: [{ id: "campaign-1", name: "Winter Refit", status: "planning", archived: false }],
    });
    expect(fixture.scopes).toEqual([
      ["opportunity_links", "client_id", "client-1"],
      ["service_offers", "client_id", "client-1"],
      ["client_campaigns", "client_id", "client-1"],
    ]);
  });

  it("refuses to present an unreadable linked offer as no linked work", async () => {
    fixture.rows.service_offers = { data: [], error: null };
    await expect(fetchOpportunityOutputs("client-1"))
      .rejects.toThrow("A linked offer could not be read.");
  });
});
