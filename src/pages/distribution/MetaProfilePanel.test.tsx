import { render, screen } from "@testing-library/react";
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

const { from, rpc, select } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), select: vi.fn() }));
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

function database(options: { identities?: unknown[]; changes?: unknown[]; presence?: unknown[]; healthError?: string } = {}) {
  from.mockImplementation((table: string) => {
    const payload = () => {
      if (table === "meta_identity_health") return options.identities ?? [identity()];
      if (table === "meta_profile_changes") return options.changes ?? [];
      return options.presence ?? [];
    };
    const response = () => ({
      data: payload(),
      error: table === "meta_identity_health" && options.healthError
        ? { message: options.healthError }
        : null,
    });
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: (columns: string) => { select(table, columns); return chain; },
      eq: () => chain,
      order: () => chain,
      limit: async () => response(),
      then: (...a: Parameters<Promise<unknown>["then"]>) =>
        Promise.resolve(response()).then(...a),
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
  it("does not call a status-and-expiry-only identity healthy", async () => {
    database({ identities: [identity({ blocker: null })] });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("No status or expiry alerts for 1 Meta identity; credential and provider access unverified"))
      .toBeInTheDocument();
    expect(screen.getByText("No status or expiry alert; credential and provider rights unverified")).toBeInTheDocument();
    expect(screen.getByText(/It does not verify the current/)).toBeInTheDocument();
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
  });

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
    expect(screen.getByText("Recorded integration status blocks this account. Reconnect or review its credential.")).toBeInTheDocument();
    // The cost of not reconnecting, attached to the reconnect.
    expect(screen.getByText("2 posts")).toBeInTheDocument();
  });

  it("warns before a token expires rather than after", async () => {
    database({
      identities: [
        identity({
          token_expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          days_left: 3,
        }),
      ],
    });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("The recorded token expiry is near. Reconnect before it expires.")).toBeInTheDocument();
    expect(screen.getByText("3 days left")).toBeInTheDocument();
  });

  it("never fetches or renders historical provider error text from identity health", async () => {
    const marker = "credential-marker-historical-provider-error";
    database({
      identities: [identity({
        status: "error",
        health_detail: `OAuth failed for ${marker}`,
        blocker: `This account is in error: OAuth failed for ${marker}.`,
      })],
    });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("Recorded integration status blocks this account. Reconnect or review its credential."))
      .toBeInTheDocument();
    expect(select).toHaveBeenCalledWith(
      "meta_identity_health",
      "client_id,provider,account_ref,status,token_expires_at,days_left,posts_waiting",
    );
    expect(document.body.textContent).not.toContain(marker);
  });

  it("keeps a raw view blocker out of the UI even when status has no alert", async () => {
    const marker = "credential-marker-hidden-view-blocker";
    database({ identities: [identity({ health_detail: marker, blocker: `OAuth error ${marker}` })] });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("No status or expiry alert; credential and provider rights unverified"))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(marker);
  });

  it("does not echo a provider marker from a failed identity read", async () => {
    const marker = "credential-marker-query-error";
    database({ healthError: `Read failed for ${marker}` });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the profiles.");
    expect(document.body.textContent).not.toContain(marker);
  });

  it("says plainly when no Meta identity is recorded", async () => {
    database({ identities: [] });
    render(<MetaProfilePanel tab="identities" />);
    expect(await screen.findByText("No Meta identity recorded")).toBeInTheDocument();
    expect(
      screen.getByText("Connect Instagram or Facebook on the Integrations page"),
    ).toBeInTheDocument();
  });
});

describe("proposed changes", () => {
  it("does not fetch or render historical proposal failure diagnostics", async () => {
    const marker = "credential-marker-historical-profile-error";
    database({ changes: [change({ last_error: `Provider rejected ${marker}` })] });
    render(<MetaProfilePanel tab="profile" />);
    expect(await screen.findByText("Garage conversions, dry in four days")).toBeInTheDocument();
    expect(select).toHaveBeenCalledWith(
      "meta_profile_changes",
      "id,platform,field,current_value,proposed_value,offer_version_id,status,created_at",
    );
    expect(document.body.textContent).not.toContain(marker);
  });

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
    expect(await screen.findByText("held for Inbox binding and an adapter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("holds direct legacy decisions until exact AAL2 Inbox binding exists", async () => {
    database({ changes: [change()] });
    render(<MetaProfilePanel tab="profile" />);
    expect(await screen.findByText("Garage conversions, dry in four days")).toBeInTheDocument();
    expect(screen.getByText(/Direct decisions are/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
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
