import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ArchiveRow } from "../../lib/contentChain";

const { calls } = vi.hoisted(() => ({ calls: [] as { table: string; filters: [string, string][] }[] }));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, filters: [] as [string, string][] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (field: string, value: string) => { call.filters.push([field, value]); return chain; };
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      return chain;
    },
  },
}));

import { ChainDetailModal } from "./ChainDetailModal";

const row: ArchiveRow = {
  client_id: "client-one", brief_ref: "AA-001", brief_id: "brief-one",
  title: "Archived campaign asset", media_type: "image", content_format: "single",
  archived_at: "2026-11-18T00:00:00Z", idea_id: "idea-one", idea_title: "Idea",
  content_territory: null, pillar_name: null, frame_count: null, assets: 1,
  approved_assets: 1, scheduled: 1, published: 1, iterations: 0,
  first_published: "2026-11-18T00:00:00Z",
};

describe("archived chain reporting", () => {
  it("scopes a client-local brief reference to its client", async () => {
    calls.length = 0;
    render(<ChainDetailModal row={row} open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Reporting" }));
    await waitFor(() => {
      const reporting = calls.find((call) => call.table === "content_attribution");
      expect(reporting?.filters).toEqual([
        ["brief_ref", "AA-001"],
        ["client_id", "client-one"],
      ]);
    });
  });
});
