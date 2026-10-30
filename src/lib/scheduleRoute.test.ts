import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, reads, rows, failures } = vi.hoisted(() => ({
  from: vi.fn(),
  reads: [] as Array<{ table: string; id: string }>,
  rows: new Map<string, Record<string, unknown> | null>(),
  failures: new Set<string>(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: (table: string) => {
      from(table);
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => {
              reads.push({ table, id });
              if (failures.has(table)) return { data: null, error: { message: "read denied" } };
              return { data: rows.get(table) ?? null, error: null };
            },
          }),
        }),
      };
    },
  },
}));

import { assertOrganicScheduleRoute } from "./scheduleRoute";

function healthyChain() {
  rows.set("client_media_assets", { id: "asset-1", client_id: "client-1", brief_id: "brief-1" });
  rows.set("client_briefs", { id: "brief-1", client_id: "client-1", source_idea_id: "idea-1" });
  rows.set("client_ideas", { id: "idea-1", client_id: "client-1", campaign_id: "campaign-1" });
  rows.set("client_campaigns", {
    id: "campaign-1", client_id: "client-1", acquisition_mode: "organic", paid_platform: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  rows.clear();
  failures.clear();
  healthyChain();
});

describe("browser scheduling route gate", () => {
  it("allows only a fresh, client-consistent, explicitly organic chain", async () => {
    await expect(assertOrganicScheduleRoute("asset-1", "organic", "client-1")).resolves.toBeUndefined();
    expect(reads).toEqual([
      { table: "client_media_assets", id: "asset-1" },
      { table: "client_briefs", id: "brief-1" },
      { table: "client_ideas", id: "idea-1" },
      { table: "client_campaigns", id: "campaign-1" },
    ]);
  });

  it("rejects a paid or unknown requested channel without reading lineage", async () => {
    await expect(assertOrganicScheduleRoute("asset-1", "paid")).rejects.toMatchObject({
      code: "schedule_route_blocked", reason: "paid_channel",
    });
    await expect(assertOrganicScheduleRoute("asset-1", "legacy")).rejects.toMatchObject({
      code: "schedule_route_blocked", reason: "unverified",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ["missing asset", "client_media_assets", null],
    ["asset without brief", "client_media_assets", { id: "asset-1", client_id: "client-1", brief_id: null }],
    ["missing brief", "client_briefs", null],
    ["brief without idea", "client_briefs", { id: "brief-1", client_id: "client-1", source_idea_id: null }],
    ["missing idea", "client_ideas", null],
    ["idea without campaign", "client_ideas", { id: "idea-1", client_id: "client-1", campaign_id: null }],
    ["missing campaign", "client_campaigns", null],
    ["legacy campaign", "client_campaigns", { id: "campaign-1", client_id: "client-1", acquisition_mode: "legacy", paid_platform: null }],
    ["inconsistent campaign fields", "client_campaigns", { id: "campaign-1", client_id: "client-1", acquisition_mode: "organic", paid_platform: "google" }],
  ] as const)("blocks %s", async (_case, table, row) => {
    rows.set(table, row);
    await expect(assertOrganicScheduleRoute("asset-1", "organic", "client-1")).rejects.toMatchObject({
      code: "schedule_route_blocked", reason: "unverified",
    });
  });

  it("names a paid campaign rather than treating it as organic", async () => {
    rows.set("client_campaigns", {
      id: "campaign-1", client_id: "client-1", acquisition_mode: "paid", paid_platform: "meta",
    });
    await expect(assertOrganicScheduleRoute("asset-1", "organic")).rejects.toMatchObject({
      code: "schedule_route_blocked", reason: "paid_campaign",
      message: expect.stringContaining("cannot use organic distribution"),
    });
  });

  it.each(["client_media_assets", "client_briefs", "client_ideas", "client_campaigns"])(
    "blocks a cross-client %s row", async (table) => {
      rows.set(table, { ...rows.get(table), client_id: "client-2" });
      await expect(assertOrganicScheduleRoute("asset-1", "organic", "client-1")).rejects.toMatchObject({
        code: "schedule_route_blocked", reason: "unverified",
      });
    },
  );

  it.each(["client_media_assets", "client_briefs", "client_ideas", "client_campaigns"])(
    "blocks an unreadable %s row", async (table) => {
      failures.add(table);
      await expect(assertOrganicScheduleRoute("asset-1", "organic", "client-1")).rejects.toMatchObject({
        code: "schedule_route_blocked", reason: "unverified",
      });
    },
  );

  it("blocks an exception instead of revealing read details", async () => {
    from.mockImplementationOnce(() => { throw new Error("internal query detail"); });
    await expect(assertOrganicScheduleRoute("asset-1", "organic")).rejects.toMatchObject({
      message: expect.not.stringContaining("internal query detail"),
      code: "schedule_route_blocked",
    });
  });
});
