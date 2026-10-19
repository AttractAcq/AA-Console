import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProofDistributionPanel } from "./ProofDistributionPanel";

/**
 * The rules worth pinning here are the ones a screen can quietly get wrong.
 *
 * Only an assisted destination is placed by hand — the database refuses it
 * for any other mode, so offering the action anywhere else is a button that
 * always fails. And a blocker from proof_placement_due has to be the thing
 * the row says, rather than the row inventing its own account of why nothing
 * has happened.
 */

const rpc = vi.fn();

const DESTINATIONS = [
  {
    destination_key: "third_party_directory", label: "Third Party Directories",
    mode: "assisted", provider: null, executor_module: "proof_distribution",
    supported: true, requires_integration: false, note: "A person places it.",
  },
  {
    destination_key: "google_business_profile", label: "Google Business Profile",
    mode: "api", provider: "google_business", executor_module: "google_profile",
    supported: false, requires_integration: true, note: "No adapter yet.",
  },
];

const state = {
  placements: [] as Record<string, unknown>[],
  due: [] as Record<string, unknown>[],
  clientDestinations: [] as Record<string, unknown>[],
  publishing: false,
};

function result(table: string) {
  switch (table) {
    case "proof_destinations": return { data: DESTINATIONS, error: null };
    case "client_proof_destinations": return { data: state.clientDestinations, error: null };
    case "proof_placements": return { data: state.placements, error: null };
    case "proof_placement_due": return { data: state.due, error: null };
    case "client_engine_settings":
      return { data: { proof_publishing_enabled: state.publishing }, error: null };
    default: return { data: [], error: null };
  }
}

const from = vi.fn((table: string) => {
  const payload = () => Promise.resolve(result(table));
  const chain: Record<string, unknown> = {
    maybeSingle: payload,
    order: payload,
    upsert: payload,
    then: (...a: Parameters<Promise<unknown>["then"]>) => payload().then(...a),
  };
  chain.eq = () => chain;
  chain.select = () => chain;
  return chain;
});

vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "c1" }) }));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (...a: unknown[]) => from(...(a as [string])),
    rpc: (...a: unknown[]) => rpc(...(a as [])),
  },
}));
vi.mock("../../lib/media", () => ({
  fetchProofAssets: async () => [
    { id: "p1", title: "Mrs Okafor's review", expires_on: null, permission_basis: "Written consent" },
  ],
}));

const placement = (over: Record<string, unknown> = {}) => ({
  id: "pl1", client_id: "c1", destination_key: "third_party_directory",
  status: "awaiting_manual_placement", source_proof_id: "p1",
  artifact_version_id: "a1", proof_id: null, asset_id: null, approval_id: null,
  external_url: null, attempts: 0, placed_at: null,
  created_at: "2026-10-18T00:00:00Z", last_error: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  state.placements = [];
  state.due = [];
  state.clientDestinations = [];
  state.publishing = false;
});

describe("destinations", () => {
  it("says which have an adapter and which this client is switched on for", async () => {
    state.clientDestinations = [{ destination_key: "third_party_directory", enabled: true, account_ref: "yell.com/aa" }];
    render(<ProofDistributionPanel tab="destinations" />);

    expect(await screen.findByText("Third Party Directories")).toBeInTheDocument();
    expect(screen.getByText("No adapter yet")).toBeInTheDocument();
    expect(screen.getByText(/Account: yell.com\/aa/)).toBeInTheDocument();
  });

  it("leads with the switch, and says plainly that nothing goes out while it is off", async () => {
    render(<ProofDistributionPanel tab="destinations" />);
    expect(await screen.findByText("Nothing is placed anywhere for this client")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_proof_publishing_enabled", {
        p_client_id: "c1", p_enabled: true,
      }),
    );
  });
});

describe("placements", () => {
  it("shows the blocker the database gave, not one of its own", async () => {
    state.placements = [placement({ status: "approved" })];
    state.due = [{
      placement_id: "pl1", destination_key: "third_party_directory",
      destination_label: "Third Party Directories", mode: "assisted", status: "approved",
      source_title: "Mrs Okafor's review", expires_on: null,
      blocker: "Permission for this proof expired on 2026-09-01.",
    }];
    render(<ProofDistributionPanel tab="placements" />);
    expect(await screen.findByText("Permission for this proof expired on 2026-09-01.")).toBeInTheDocument();
  });

  it("offers Mark placed only for an assisted destination", async () => {
    state.placements = [placement()];
    render(<ProofDistributionPanel tab="placements" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    expect(await screen.findByRole("menuitem", { name: "Mark placed" })).toBeInTheDocument();
  });

  it("gives an api placement waiting on the sweep nothing to click", async () => {
    // mark_proof_placement_placed_v6 refuses anything that is not assisted,
    // and a queued api placement is waiting on the runtime rather than on a
    // person — so the row offers no actions at all rather than one that
    // would always fail.
    state.placements = [placement({ destination_key: "google_business_profile", status: "queued" })];
    render(<ProofDistributionPanel tab="placements" />);
    expect(await screen.findByText("Google Business Profile")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.queryByText("Mark placed")).not.toBeInTheDocument();
  });

  it("asks for approval separately from approving the artifact", async () => {
    state.placements = [placement({ status: "drafted" })];
    render(<ProofDistributionPanel tab="placements" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ask for approval" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("request_proof_placement_approval_v6", { p_placement_id: "pl1" }),
    );
  });
});

describe("rights", () => {
  it("leads with what has to come down, and is quiet when nothing does", async () => {
    state.placements = [placement({ status: "verified", external_url: "https://directory.example/9" })];
    render(<ProofDistributionPanel tab="rights" />);
    expect(
      await screen.findByText(/Every live placement rests on proof that is still cleared/),
    ).toBeInTheDocument();
    expect(screen.getByText("On: Written consent")).toBeInTheDocument();
  });

  it("names the live placement and where to go and look at it", async () => {
    state.placements = [placement({ status: "retraction_required", external_url: "https://directory.example/9" })];
    state.due = [{
      placement_id: "pl1", destination_key: "third_party_directory",
      destination_label: "Third Party Directories", mode: "assisted",
      status: "retraction_required", source_title: "Mrs Okafor's review",
      expires_on: "2026-09-01", blocker: null,
    }];
    render(<ProofDistributionPanel tab="rights" />);
    const section = (await screen.findByText("Needs taking down")).parentElement!;
    expect(within(section).getByText("https://directory.example/9")).toBeInTheDocument();
  });
});
