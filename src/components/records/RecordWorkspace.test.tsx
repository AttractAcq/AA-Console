import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../lib/supabase", () => {
  const rows: Record<string, unknown[]> = {
    record_templates: [{ item_key: "market_size", item_type: "section", title: "Market size", description: null, display_order: 1 }],
    client_agent_records: [{ id: "record-1", item_key: "market_size", item_type: "section", title: "Market size",
      body: "Corrected market size", period: null, display_order: 1, status: "active", edited_at: "2026-11-19",
      updated_at: "2026-11-19T20:00:00Z", job_id: null }],
    model_section_review_state_v7: [{ record_id: "record-1", review_state: "stale",
      source_ref: "Industry report", observed_on: "2026-11-18", confidence: "supported",
      reviewed_at: "2026-11-18", review_note: "Earlier text checked" }],
  };
  const chain = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "limit"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows[table] ?? [], error: null });
    query.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return query;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { from: (table: string) => chain(table), channel: () => channel,
    removeChannel: vi.fn(), rpc: vi.fn() } };
});

vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../ArchiveAction", () => ({ ArchiveAction: () => null }));
vi.mock("../forms/AgentSteerForm", async (original) => ({
  ...(await original<Record<string, unknown>>()), AgentSteerForm: () => null,
}));
vi.mock("../forms/FormModal", () => ({
  FormModal: ({ open, title, initialValues }: { open: boolean; title: string;
    initialValues: Record<string, unknown> }) => open
    ? <div role="dialog" aria-label={title}><pre data-testid="review-values">{JSON.stringify(initialValues)}</pre></div>
    : null,
}));

const { RecordWorkspace } = await import("./RecordWorkspace");

describe("model source review", () => {
  it("preserves source details but requires a fresh confidence decision after an edit", async () => {
    render(<MemoryRouter initialEntries={["/clients/client-1"]}>
      <Routes><Route path="/clients/:clientId" element={<RecordWorkspace domain="market" />} /></Routes>
    </MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Market size" }));
    await userEvent.click(screen.getByRole("button", { name: "Review source" }));
    const values = JSON.parse(screen.getByTestId("review-values").textContent ?? "{}") as Record<string, string>;
    expect(values).toMatchObject({ source_ref: "Industry report", observed_on: "2026-11-18",
      review_note: "Earlier text checked", confidence: "" });
  });
});
