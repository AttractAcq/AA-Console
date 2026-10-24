import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Three things this page must not get wrong.
 *
 * A captured review has to be marked as captured, so nobody captures it
 * twice into the Proof Bank. A review that has left the profile must say so
 * rather than silently offering a reply nobody can post. And Posts must read
 * as a mirror: a second publisher on this page is how a client gets the same
 * testimonial on their profile twice.
 */

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { GoogleProfilePanel } from "./GoogleProfilePanel";

const location = (over: Record<string, unknown> = {}) => ({
  id: "loc-1", client_id: "client-1", location_ref: "accounts/1184/locations/7730",
  title: "Harbour Home · Portsmouth", address: null, primary_phone: null, website_url: null,
  verification_state: "verified", profile_snapshot: {}, missing_fields: ["services", "hours"],
  last_read_at: "2026-10-24T09:00:00Z", last_read_error: null, created_by: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-24T09:00:00Z", ...over,
});

const due = (over: Record<string, unknown> = {}) => ({
  location_id: "loc-1", client_id: "client-1", location_ref: "accounts/1184/locations/7730",
  title: "Harbour Home · Portsmouth", verification_state: "verified",
  missing_fields: ["services", "hours"], last_read_at: "2026-10-24T09:00:00Z",
  last_read_error: null, reviews: 46, unanswered: 9, captured_as_proof: 12,
  gone_but_cited: 0, blocker: null, ...over,
});

const review = (over: Record<string, unknown> = {}) => ({
  id: "rev-1", client_id: "client-1", location_id: "loc-1", review_ref: "r1",
  author_name: "J. Okafor", star_rating: 5,
  comment: "They did the garage in four days and it is bone dry.",
  review_url: "https://g.co/r/abc", reviewed_at: "2026-10-14T10:00:00Z",
  seen_at: "2026-10-24T09:00:00Z", gone_at: null, captured_proof_id: null,
  created_at: "2026-10-24T09:00:00Z", ...over,
});

function database(options: {
  locations?: unknown[]; due?: unknown[]; reviews?: unknown[];
  replies?: unknown[]; placements?: unknown[];
} = {}) {
  from.mockImplementation((table: string) => {
    const payload = () => {
      switch (table) {
        case "client_google_locations": return options.locations ?? [location()];
        case "google_profile_due": return options.due ?? [due()];
        case "google_reviews": return options.reviews ?? [review()];
        case "google_review_replies": return options.replies ?? [];
        default: return options.placements ?? [];
      }
    };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: payload(), error: null }),
      insert: async () => ({ error: null }),
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

describe("the location", () => {
  it("shows what is missing as approved changes rather than edits", async () => {
    render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText(/Missing from the profile: services, hours/)).toBeInTheDocument();
    expect(screen.getByText(/not an edit this page makes by itself/)).toBeInTheDocument();
  });

  it("leads with the blocker when the credential cannot see the location", async () => {
    database({
      due: [due({ blocker: "This credential cannot see the location any more.", verification_state: "no_access" })],
      locations: [location({ verification_state: "no_access" })],
    });
    render(<GoogleProfilePanel tab="location" />);
    expect(
      await screen.findByText("This credential cannot see the location any more."),
    ).toBeInTheDocument();
  });

  it("counts reviews that left the profile while proof rests on them", async () => {
    database({ due: [due({ gone_but_cited: 3 })] });
    render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText("Gone but cited")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("says plainly when nothing is connected", async () => {
    database({ locations: [], due: [] });
    render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText("No location is connected")).toBeInTheDocument();
  });
});

describe("reviews", () => {
  it("captures one into the Proof Bank, uncleared", async () => {
    render(<GoogleProfilePanel tab="reviews" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Capture as proof" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("capture_google_review_as_proof_v6", {
        p_review_id: "rev-1",
      }),
    );
    // The standing explanation on the tab also says "uncleared", so assert
    // on the notice this action produces rather than on the word.
    expect(
      await screen.findByText("Captured into the Proof Bank, uncleared."),
    ).toBeInTheDocument();
  });

  it("does not offer to capture one that already has been", async () => {
    database({ reviews: [review({ captured_proof_id: "proof-1" })] });
    render(<GoogleProfilePanel tab="reviews" />);
    expect(await screen.findByText("captured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    expect(screen.queryByRole("menuitem", { name: "Capture as proof" })).not.toBeInTheDocument();
  });

  it("says a review has gone, and offers no reply to it", async () => {
    database({ reviews: [review({ gone_at: "2026-10-20T00:00:00Z" })] });
    render(<GoogleProfilePanel tab="reviews" />);
    expect(await screen.findByText("No longer on the profile")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    expect(screen.queryByRole("menuitem", { name: "Draft a reply" })).not.toBeInTheDocument();
  });

  it("offers approval of a drafted reply, and rejection with a reason", async () => {
    database({
      replies: [{
        id: "reply-1", client_id: "client-1", review_id: "rev-1",
        body: "Thanks Jay.", body_hash: "a".repeat(64), drafted_by_job_id: null,
        status: "drafted", approved_by: null, approved_at: null, rejection_reason: null,
        attempts: 0, lease_until: null, external_ref: null, posted_at: null, last_error: null,
        created_by: null, created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z",
      }],
    });
    render(<GoogleProfilePanel tab="reviews" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Actions for / }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Approve this reply" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("decide_google_review_reply_v6", {
        p_reply_id: "reply-1",
        p_approved: true,
      }),
    );
  });
});

describe("posts and metrics", () => {
  it("presents Posts as a mirror rather than a publisher", async () => {
    render(<GoogleProfilePanel tab="posts" />);
    expect(await screen.findByText(/A mirror, not a second publisher/)).toBeInTheDocument();
    // No way to post from here: that would be two things able to post to one
    // profile.
    expect(screen.queryByRole("button", { name: /Post/i })).not.toBeInTheDocument();
  });

  it("says metrics are not ingested rather than showing zeroes", async () => {
    render(<GoogleProfilePanel tab="metrics" />);
    expect(await screen.findByText(/nothing in this runtime calls yet/)).toBeInTheDocument();
    expect(screen.getByText(/Rather than show zeroes that look like data/)).toBeInTheDocument();
  });
});
