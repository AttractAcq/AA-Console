import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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

const { from, rpc, insert, useParams, modalProps } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), insert: vi.fn(), useParams: vi.fn(), modalProps: [] as unknown[],
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("../../components/forms/FormModal", () => ({
  FormModal: (props: unknown) => { modalProps.push(props); return null; },
}));

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

const change = (over: Record<string, unknown> = {}) => ({
  id: "change-1", client_id: "client-1", location_id: "loc-1",
  field: "description", current_value: "Old description", proposed_value: "New description",
  status: "approved", attempts: 0, applied_at: null, last_error: null,
  created_at: "2026-10-24T09:00:00Z", ...over,
});

function database(options: {
  locations?: unknown[]; due?: unknown[]; reviews?: unknown[];
  replies?: unknown[]; placements?: unknown[]; changes?: unknown[];
} = {}) {
  from.mockImplementation((table: string) => {
    const payload = () => {
      switch (table) {
        case "client_google_locations": return options.locations ?? [location()];
        case "google_profile_due": return options.due ?? [due()];
        case "google_profile_changes": return options.changes ?? [];
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

type ReadResult = { data: unknown[]; error: { message: string } | null };

function deferredRead() {
  let resolve!: (value: ReadResult) => void;
  const promise = new Promise<ReadResult>((done) => { resolve = done; });
  return { promise, resolve };
}

function routeDatabase(pending: Record<string, Promise<ReadResult>> = {}) {
  from.mockImplementation((table: string) => {
    let selectedClient = "";
    const payload = () => {
      const locationId = `loc-${selectedClient}`;
      switch (table) {
        case "client_google_locations": return [location({
          id: locationId, client_id: selectedClient, title: `Location ${selectedClient}`,
        })];
        case "google_profile_changes": return [change({
          id: `change-${selectedClient}`, client_id: selectedClient, location_id: locationId,
          proposed_value: `Proposal ${selectedClient}`,
        })];
        case "google_reviews": return [review({
          id: `review-${selectedClient}`, client_id: selectedClient,
          location_id: locationId, author_name: `Reviewer ${selectedClient}`,
        })];
        default: return [];
      }
    };
    const response = () => pending[`${selectedClient}:${table}`]
      ?? Promise.resolve({ data: payload(), error: null });
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        if (key === "client_id") selectedClient = String(value);
        return chain;
      },
      order: () => chain,
      limit: () => response(),
      insert: async (value: unknown) => { insert(value); return { error: null }; },
      then: (...a: Parameters<Promise<ReadResult>["then"]>) => response().then(...a),
    });
    return chain;
  });
  rpc.mockResolvedValue({ data: null, error: null });
}

type CapturedModal = {
  open: boolean;
  title: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
};

function lastOpenModal(title: string): CapturedModal {
  const found = [...modalProps].reverse().find((item) => {
    const modal = item as CapturedModal;
    return modal.open && modal.title === title;
  });
  if (!found) throw new Error(`Modal ${title} was not opened.`);
  return found as CapturedModal;
}

function latestModal(title: string): CapturedModal {
  const found = [...modalProps].reverse().find((item) => (item as CapturedModal).title === title);
  if (!found) throw new Error(`Modal ${title} was not rendered.`);
  return found as CapturedModal;
}

beforeEach(() => {
  vi.clearAllMocks();
  modalProps.length = 0;
  useParams.mockReturnValue({ clientId: "client-1" });
  database();
});

describe("the location", () => {
  it("shows missing fields without promising an approved provider PATCH", async () => {
    render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText(/Missing from the profile: services, hours/)).toBeInTheDocument();
    expect(screen.getByText(/automatic field PATCH is held/)).toBeInTheDocument();
    expect(screen.getByText("No location-read blocker was reported.")).toBeInTheDocument();
    expect(screen.queryByText(/nothing is blocking a change/)).not.toBeInTheDocument();
  });

  it("marks a formerly approved field proposal held even when the location read has no blocker", async () => {
    database({ changes: [change()] });
    render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText("New description")).toBeInTheDocument();
    expect(screen.getByText("Old description")).toBeInTheDocument();
    expect(screen.getByText("Held; no field PATCH will be claimed.")).toBeInTheDocument();
    expect(screen.getByText(/exact-version AAL2 Approval Inbox decision/)).toBeInTheDocument();
    expect(from).toHaveBeenCalledWith("google_profile_changes");
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

  it("removes A proposals immediately when B's route is still loading", async () => {
    let clientId = "client-a";
    useParams.mockImplementation(() => ({ clientId }));
    const bRead = deferredRead();
    routeDatabase({ "client-b:google_profile_changes": bRead.promise });
    const page = render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText("Proposal client-a")).toBeInTheDocument();

    clientId = "client-b";
    page.rerender(<GoogleProfilePanel tab="location" />);
    expect(screen.queryByText("Proposal client-a")).not.toBeInTheDocument();
    expect(screen.queryAllByText("Location client-a")).toHaveLength(0);

    await act(async () => {
      bRead.resolve({ data: [change({
        id: "change-client-b", client_id: "client-b", location_id: "loc-client-b",
        proposed_value: "Proposal client-b",
      })], error: null });
      await bRead.promise;
    });
    expect(await screen.findByText("Proposal client-b")).toBeInTheDocument();
  });

  it("keeps B loading until B resolves even when an earlier A read finishes", async () => {
    let clientId = "client-a";
    useParams.mockImplementation(() => ({ clientId }));
    const aRead = deferredRead();
    const bRead = deferredRead();
    routeDatabase({
      "client-a:google_profile_changes": aRead.promise,
      "client-b:google_profile_changes": bRead.promise,
    });
    const page = render(<GoogleProfilePanel tab="location" />);
    await waitFor(() => expect(from).toHaveBeenCalledWith("google_profile_changes"));

    clientId = "client-b";
    page.rerender(<GoogleProfilePanel tab="location" />);
    await act(async () => {
      aRead.resolve({ data: [change({ proposed_value: "Late A proposal" })], error: null });
      await aRead.promise;
    });
    expect(screen.queryByText("Late A proposal")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    await act(async () => {
      bRead.resolve({ data: [change({
        client_id: "client-b", location_id: "loc-client-b", proposed_value: "B proposal",
      })], error: null });
      await bRead.promise;
    });
    expect(await screen.findByText("B proposal")).toBeInTheDocument();
    expect(screen.queryByText("Late A proposal")).not.toBeInTheDocument();
  });

  it("ignores a late A read error after B has loaded", async () => {
    let clientId = "client-a";
    useParams.mockImplementation(() => ({ clientId }));
    const aRead = deferredRead();
    routeDatabase({ "client-a:google_profile_changes": aRead.promise });
    const page = render(<GoogleProfilePanel tab="location" />);
    await waitFor(() => expect(from).toHaveBeenCalledWith("google_profile_changes"));

    clientId = "client-b";
    page.rerender(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByText("Proposal client-b")).toBeInTheDocument();
    await act(async () => {
      aRead.resolve({ data: [], error: { message: "A credential error" } });
      await aRead.promise;
    });
    expect(screen.getByText("Proposal client-b")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects stale A form callbacks after B and after returning to A", async () => {
    let clientId = "client-a";
    useParams.mockImplementation(() => ({ clientId }));
    routeDatabase();
    const page = render(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByRole("heading", { name: "Location client-a" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect a location" }));
    const oldConnect = await waitFor(() => lastOpenModal("Connect a Business Profile location"));

    clientId = "client-b";
    page.rerender(<GoogleProfilePanel tab="location" />);
    expect(await screen.findByRole("heading", { name: "Location client-b" })).toBeInTheDocument();
    expect(latestModal("Connect a Business Profile location").open).toBe(false);
    await expect(oldConnect.onSubmit({ location_ref: "accounts/a/locations/1", title: "A draft" }))
      .rejects.toThrow("Client selection changed. Reopen the form.");
    expect(insert).not.toHaveBeenCalled();

    clientId = "client-a";
    page.rerender(<GoogleProfilePanel tab="reviews" />);
    expect(await screen.findByText("Reviewer client-a")).toBeInTheDocument();
    expect(latestModal("Connect a Business Profile location").open).toBe(false);
    await expect(oldConnect.onSubmit({ location_ref: "accounts/a/locations/1", title: "A draft" }))
      .rejects.toThrow("Client selection changed. Reopen the form.");
    expect(insert).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Draft a reply" }));
    const oldReply = await waitFor(() => lastOpenModal("Reply to Reviewer client-a"));
    clientId = "client-b";
    page.rerender(<GoogleProfilePanel tab="reviews" />);
    expect(await screen.findByText("Reviewer client-b")).toBeInTheDocument();
    expect(latestModal("Draft a reply").open).toBe(false);
    clientId = "client-a";
    page.rerender(<GoogleProfilePanel tab="reviews" />);
    expect(await screen.findByText("Reviewer client-a")).toBeInTheDocument();
    expect(latestModal("Draft a reply").open).toBe(false);
    await expect(oldReply.onSubmit({ body: "A stale draft" }))
      .rejects.toThrow("Client selection changed. Reopen the form.");
    expect(rpc).not.toHaveBeenCalled();
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

  it("routes a drafted reply to the unified Inbox instead of deciding an unchecked version", async () => {
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
    expect(await screen.findByRole("link", { name: "Review in Approval Inbox" }))
      .toHaveAttribute("href", "/clients/client-1/delivery/approval-inbox?tab=unified");
    await userEvent.click(screen.getByRole("button", { name: /^Actions for / }));
    expect(screen.queryByRole("menuitem", { name: "Approve this reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Reject it" })).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith("decide_google_review_reply_v6", expect.anything());
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
