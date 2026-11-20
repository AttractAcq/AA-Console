import { beforeEach, expect, it, vi } from "vitest";

const { from, select, eq, ilike, order, limit } = vi.hoisted(() => ({
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), ilike: vi.fn(),
  order: vi.fn(), limit: vi.fn(),
}));
vi.mock("./supabase", () => ({ supabase: { from } }));

import { loadProductionDemands } from "./options";

beforeEach(() => {
  vi.clearAllMocks();
  const query = { select, eq, ilike, order, limit };
  from.mockReturnValue(query);
  select.mockReturnValue(query);
  eq.mockReturnValue(query);
  ilike.mockReturnValue(query);
  order.mockReturnValue(query);
  limit.mockResolvedValue({ data: [{ demand_kind: "campaign", demand_id: "request-1",
    piece_key: "older_piece", destination: "facebook", requested_at: "2026-11-01T00:00:00Z" }], error: null });
});

it("searches within the selected client and brief and preserves literal piece-key characters", async () => {
  const result = await loadProductionDemands("client-1", "brief-1", "older_piece% ");
  expect(from).toHaveBeenCalledWith("assignable_production_demands_v7");
  expect(eq).toHaveBeenCalledWith("client_id", "client-1");
  expect(eq).toHaveBeenCalledWith("brief_id", "brief-1");
  expect(ilike).toHaveBeenCalledWith("piece_key", "%older\\_piece\\%%");
  expect(order).toHaveBeenCalledWith("requested_at", { ascending: false });
  expect(limit).toHaveBeenCalledWith(200);
  expect(result).toEqual([{ value: "campaign:request-1",
    label: "campaign · older_piece · facebook · 2026-11-01 · request-" }]);
});
