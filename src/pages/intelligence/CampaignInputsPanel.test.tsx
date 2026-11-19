import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, useParams } = vi.hoisted(() => ({ from: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({
  useParams,
  Link: ({ to, children }: { to: string; children?: unknown }) =>
    createElement("a", { href: to }, children as never),
}));

import { CampaignInputsPanel } from "./CampaignInputsPanel";

function reads(...responses: Array<{ data: unknown[] | null; error: { message: string } | null }>) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(responses.shift()).then(resolve);
  from.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("campaign input evidence", () => {
  it("shows a failed read as unavailable and lets the operator retry", async () => {
    reads(
      { data: null, error: { message: "permission denied" } },
      { data: [], error: null },
    );
    render(<CampaignInputsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.queryByText(/No campaign has captured/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No campaign has captured/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("labels a combined route without dropping its paid side", async () => {
    reads({ data: [{
      id: "snapshot-1", client_id: "client-1", campaign_id: "campaign-1",
      acquisition_mode: "both", paid_platform: "meta", captured_at: "2026-11-19T10:00:00Z",
      source_records: [], brief: "Serve the niche", snapshot_hash: "abc", missing_domains: [],
    }], error: null });
    render(<CampaignInputsPanel />);

    expect((await screen.findAllByText("meta + organic campaign"))).toHaveLength(1);
    expect(screen.queryByText("Organic campaign")).not.toBeInTheDocument();
  });
});
