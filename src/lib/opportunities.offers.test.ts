import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: {} as Record<string, { data: unknown[] | null; error: { message: string } | null }>,
  filters: [] as Array<[string, string, string]>,
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        const query = {
          eq(column: string, value: string) {
            fixture.filters.push([table, column, value]);
            return query;
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(fixture.rows[table]).then(resolve);
          },
        };
        return query;
      },
    }),
  },
}));

import { fetchOpportunityOfferVersions } from "./opportunities";

beforeEach(() => {
  fixture.filters = [];
  fixture.rows = {
    opportunity_links: { data: [{ offer_id: "secondary-1" }], error: null },
    service_offers: { data: [
      { id: "secondary-1", service_name: "Garage refit", kind: "secondary" },
      { id: "main-1", service_name: "General service", kind: "main" },
    ], error: null },
    service_offer_versions: { data: [
      { id: "v1", offer_id: "secondary-1", version: 1, promise: "A usable garage" },
      { id: "v2", offer_id: "secondary-1", version: 2, promise: "A warm garage" },
      { id: "main-v1", offer_id: "main-1", version: 1, promise: "General service" },
    ], error: null },
    service_offer_signoffs: { data: [
      { offer_version_id: "v1" }, { offer_version_id: "main-v1" },
    ], error: null },
  };
});

describe("opportunity campaign offer choices", () => {
  it("holds a superseded signed version until the latest secondary version is signed", async () => {
    expect(await fetchOpportunityOfferVersions("client-1", "opp-1")).toEqual([]);
    fixture.rows.service_offer_signoffs = { data: [{ offer_version_id: "v2" }], error: null };
    expect(await fetchOpportunityOfferVersions("client-1", "opp-1"))
      .toEqual([{ id: "v2", label: "Garage refit v2 · A warm garage" }]);
    expect(fixture.filters).toContainEqual(["opportunity_links", "opportunity_id", "opp-1"]);
    expect(fixture.filters.filter(([, column]) => column === "client_id")).toHaveLength(8);
  });

  it("surfaces a failed version read instead of an empty offer list", async () => {
    fixture.rows.service_offer_versions = { data: null, error: { message: "permission denied" } };
    await expect(fetchOpportunityOfferVersions("client-1", "opp-1"))
      .rejects.toThrow("permission denied");
  });
});
