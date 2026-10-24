import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The failure this page exists to make impossible.
 *
 * A disconnected Meta account used to appear as an empty post board, which is
 * indistinguishable from a client with nothing scheduled. So a broken
 * credential has to say so in words, with the count of what is waiting on it
 * attached — and an approved profile change must not claim to have been
 * applied, because this runtime has no Meta profile-write adapter.
 */

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { MetaProfilePanel } from "./MetaProfilePanel";

const identity = (over: Record<string, unknown> = {}) => ({
  client_id: "client-1", provider: "instagram", account_ref: "17841400000000000",
  status: "connected", ingest_enabled: true, token_expires_at: "2026-12-17T00:00:00Z",
  health_detail: null, last_checked_at: "2026-10-24T09:00:00Z", days_left: 54,
  posts_waiting: 0, blocker: null, ...over,
});

const change = (over: Record<string, unknown> = {}) => ({
  id: "chg-1", client_id: "client-1", platform: "instagram", field: "bio",
  current_value: "Home improvements Portsmouth", proposed_value: "Garage conversions, dry in four days",
  offer_version_id: "ver-3", reason: null, status: "drafted",
  approved_by: null, approved_at: null, rejection_reason: null, applied_at: null,
  external_ref: null, last_error: null, created_by: null,
  created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z", ...over,
});

const post = (over: Record<string, unknown> = {}) => ({
  post_id: "post-1", client_id: "client-1", platform: "instagram",
  publication_status: "published", external_id: "ig_17912", external_url: "https://instagram.com/p/x",
  published_at: "2026-10-20T18:00:00Z", scheduled_at: "2026-10-20T18:00:00Z",
  asset_id: "asset-1", campaign_id: "camp-1", campaign_name: "Winter garage push",
  proof_asset_id: "proof-1", proof_title: "Four-day conversion",
  carries_placed_proof: true, ...over,
});

function database(options: { identities?: unknown[]; changes?: unknown[]; presence?: unknown[] } = {}) {
  from.mockImplementation((table: string) => {
    const payload = () => {
      if (table === "meta_identity_health") return options.identities ?? [identity()];
      if (table === "meta_profile_changes") return options.changes ?? [];
      return options.presence ?? [];
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: payload(), error: null }),
      then: (...a: Parameters<Promise<unknown>["then"]>) =>
        Promise.resolve({ data: payload(), error: null }).then(...a),
    });
    return chain;
  });
  rpc.mockResolvedValue({ data: null, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  database();
});

describe("identities", () => {
  it("says a broken credential is broken, with what is waiting on it", async () => {
    database({
      identities: [
        identity(),
        identity({
          provider: "facebook", account_ref: "1184772", status: "error",
          health_detail: "token expired", days_left: 0, posts_waiting: 2,
          blocker: "This account is in error: token expired.",
        }),
      ],
    });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("1 of 2 identities need attention")).toBeInTheDocument();
    expect(screen.getByText("This account is in error: token expired.")).toBeInTheDocument();
    // The cost of not reconnecting, attached to the reconnect.
    expect(screen.getByText("2 posts")).toBeInTheDocument();
  });

  it("warns before a token expires rather than after", async () => {
    database({
      identities: [
        identity({ days_left: 3, blocker: "The token expires on 2026-10-27. Reconnect before it does." }),
      ],
    });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText(/Reconnect before it does/)).toBeInTheDocument();
    expect(screen.getByText("3 days left")).toBeInTheDocument();
  });

  it("says plainly when nothing is connected", async () => {
    database({ identities: [] });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("No Meta identity is connected")).toBeInTheDocument();
    expect(
      screen.getByText("Connect Instagram or Facebook on the Integrations page"),
    ).toBeInTheDocument();
  });
});

describe("proposed changes", () => {
  it("shows what the profile says beside what it would say", async () => {
    database({ changes: [change()] });
    render(<MetaProfilePanel tab="profile" />);
    expect(await screen.findByText("Home improvements Portsmouth")).toBeInTheDocument();
    expect(screen.getByText("Garage conversions, dry in four days")).toBeInTheDocument();
    expect(screen.getByText("from a signed offer")).toBeInTheDocument();
  });

  it("does not claim an approved change was applied", async () => {
    database({ changes: [change({ status: "approved", approved_at: "2026-10-24T10:00:00Z" })] });
    render(<MetaProfilePanel tab="profile" />);
    // There is no Meta profile-write adapter, and the page says so instead of
    // implying the profile changed.
    expect(await screen.findByText("waiting for an adapter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("approves a draft, and refuses to reject without a reason", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("  ");
    database({ changes: [change()] });
    render(<MetaProfilePanel tab="profile" />);

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(rpc).not.toHaveBeenCalled();
    prompt.mockRestore();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("decide_meta_profile_change_v6", {
        p_change_id: "chg-1",
        p_approved: true,
      }),
    );
  });
});

describe("presence", () => {
  it("marks the posts carrying placed proof", async () => {
    database({ presence: [post(), post({ post_id: "post-2", carries_placed_proof: false, proof_title: null })] });
    render(<MetaProfilePanel tab="presence" />);
    // Both rows carry the same campaign, so the campaign name appears twice.
    expect((await screen.findAllByText("Winter garage push")).length).toBe(2);
    // Only one carries placed proof, and those are the ones that come down if
    // permission ends.
    expect(screen.getByText("placed proof")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("presents itself as a mirror of what Content Distribution published", async () => {
    database({ presence: [post()] });
    render(<MetaProfilePanel tab="presence" />);
    expect(await screen.findByText(/Content Distribution owns publishing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish/i })).not.toBeInTheDocument();
  });
});
