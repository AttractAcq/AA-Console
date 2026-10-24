import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What this board must not let somebody do by accident.
 *
 * Meta object creation is not idempotent, so a campaign that already has
 * objects must not offer a build. And a build whose budget or creative set
 * changed after the yes has to read as changed rather than as ready — the
 * money is the whole reason the gate exists.
 *
 * "Built" is also deliberately not "live": activation is a separate approval
 * that does not exist yet, so nothing here offers it.
 */

const { from, callRuntime } = vi.hoisted(() => ({ from: vi.fn(), callRuntime: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { MetaBuildApprovalPanel } from "./MetaBuildApprovalPanel";

const row = (over: Record<string, unknown> = {}) => ({
  campaign_id: "camp-1", client_id: "client-1", name: "Winter garage push",
  meta_campaign_id: null, meta_ad_set_id: null, meta_built_at: null,
  approval_id: null, approval_status: null,
  approved_hash: null, current_hash: "a".repeat(64), approved_creative: 2,
  blocker: "Nobody has approved a build for this campaign.", ...over,
});

function database(rows: unknown[]) {
  from.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { select: () => chain, eq: async () => ({ data: rows, error: null }) });
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  callRuntime.mockResolvedValue({ approvalId: "app-1" });
});

describe("asking for the build", () => {
  it("offers it when nobody has been asked", async () => {
    database([row()]);
    render(<MetaBuildApprovalPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Ask for approval" }));
    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/campaign-actions/request", {
        clientId: "client-1",
        campaignId: "camp-1",
        actionKey: "meta_ad_build",
      }),
    );
    expect(await screen.findByText(/under Campaign actions/)).toBeInTheDocument();
  });

  it("does not offer it again while a decision is outstanding", async () => {
    database([row({ approval_status: "pending", blocker: "The build approval is pending." })]);
    render(<MetaBuildApprovalPanel />);
    expect(await screen.findByText("The build approval is pending.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask for approval/ })).not.toBeInTheDocument();
  });

  it("offers a fresh ask when the build drifted from what was signed off", async () => {
    database([
      row({
        approval_status: "approved",
        approved_hash: "b".repeat(64),
        blocker: "The account, budget, audience or creative set changed after approval. Ask again.",
      }),
    ]);
    render(<MetaBuildApprovalPanel />);
    expect(await screen.findByText(/changed after approval/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
    expect(screen.getByText(/1 changed since approval/)).toBeInTheDocument();
  });
});

describe("what it refuses to offer", () => {
  it("never offers a second build for a campaign that already has objects", async () => {
    database([
      row({
        meta_campaign_id: "23851000", meta_ad_set_id: "23852000",
        meta_built_at: "2026-10-24T09:00:00Z", approval_status: "approved",
        approved_hash: "a".repeat(64),
        blocker: "Built. Activation is a separate decision.",
      }),
    ]);
    render(<MetaBuildApprovalPanel />);
    expect(await screen.findByText("23851000")).toBeInTheDocument();
    // A second run makes a second campaign somebody pays for.
    expect(screen.queryByRole("button", { name: /Ask/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 built")).toBeInTheDocument();
  });

  it("says built rather than live, and offers no activation", async () => {
    database([
      row({ meta_campaign_id: "23851000", blocker: "Built. Activation is a separate decision." }),
    ]);
    render(<MetaBuildApprovalPanel />);
    expect(
      await screen.findByText("Built. Activation is a separate decision."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^live$/i)).not.toBeInTheDocument();
  });

  it("shows the blocker the database gave rather than inventing one", async () => {
    database([row({ approved_creative: 0, blocker: "No approved creative is attached yet." })]);
    render(<MetaBuildApprovalPanel />);
    expect(await screen.findByText("No approved creative is attached yet.")).toBeInTheDocument();
    expect(screen.getByText("0 approved")).toBeInTheDocument();
  });

  it("says plainly when there is no paid Meta campaign at all", async () => {
    database([]);
    render(<MetaBuildApprovalPanel />);
    expect(
      await screen.findByText("No paid Meta campaign yet — create one in Campaign Factory"),
    ).toBeInTheDocument();
  });
});
