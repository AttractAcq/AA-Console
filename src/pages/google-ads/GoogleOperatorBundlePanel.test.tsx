import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { GoogleOperatorBundlePanel } from "./GoogleOperatorBundlePanel";

const bundle = {
  id: "bundle-1", client_id: "client-1", campaign_id: "campaign-1", sheet_id: "sheet-1",
  version: 1, snapshot: { owner: "Operator" }, snapshot_hash: "a".repeat(64),
  created_at: "2026-11-16T00:00:00Z", created_by: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation((table: string) => {
    const rows = table === "google_operator_bundles_v7" ? [bundle] : [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, order: () => chain,
      limit: async () => ({ data: rows, error: null }),
    });
    return chain;
  });
  rpc.mockImplementation(async (name: string) => ({
    data: name === "google_operator_bundle_approved_v7"
      || name === "google_operator_bundle_current_v7" ? true
      : name === "google_operator_bundle_export_v7" ? '{"owner":"Different"}' : null,
    error: null,
  }));
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Google operator export", () => {
  it("blocks handoff when exported bytes differ from the reviewed hash", async () => {
    render(<GoogleOperatorBundlePanel sheets={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: "Download exact JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Export differs from the reviewed Google bundle.",
    );
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("google_operator_bundle_export_v7", {
      p_bundle_id: bundle.id,
    }));
    expect(rpc).not.toHaveBeenCalledWith("record_google_operator_event_v7", expect.anything());
  });

  it("selects an approved current bundle for an operator report", async () => {
    const approvedBundle = { ...bundle, id: "bundle-2", version: 2,
      snapshot_hash: "b".repeat(64) };
    from.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, order: () => chain,
        limit: async () => ({ data: table === "google_operator_bundles_v7"
          ? [bundle, approvedBundle] : [], error: null }),
      });
      return chain;
    });
    rpc.mockImplementation(async (name: string, args?: { p_bundle_id?: string }) => ({
      data: name === "google_operator_bundle_current_v7" ? true
        : name === "google_operator_bundle_approved_v7"
          ? args?.p_bundle_id === approvedBundle.id : null,
      error: null,
    }));
    render(<GoogleOperatorBundlePanel sheets={[]} />);
    const select = await screen.findByRole("combobox", { name: "Approved bundle" });
    await waitFor(() => expect(select).toHaveValue(approvedBundle.id));
    await userEvent.type(screen.getByRole("textbox", { name: "Evidence reference" }), "handoff-42");
    await userEvent.click(screen.getByRole("button", { name: "Record operator report" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("record_google_operator_event_v7",
      expect.objectContaining({ p_bundle_id: approvedBundle.id,
        p_event: "handoff_reported", p_reference: "handoff-42" })));
  });
});
