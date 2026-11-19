import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What this surface exists to make visible.
 *
 * v1's pipeline could not say where a lead came from, because every lead in
 * it was typed in by somebody. So the assertions here are about provenance:
 * the consent is shown as the words agreed to, a returning person reads as
 * one lead with several touches rather than a duplicate, and a submission
 * that merged into an existing lead is still listed as having happened.
 */

const {
  fetchCapturedLeads, fetchEndpoints, fetchSubmissions, createEndpoint, setEndpointEnabled,
  fetchArchivedReturnPacket, resolveArchivedReturn, fetchArchivedReturnBatchPacket,
  resolveArchivedReturnBatch,
} = vi.hoisted(() => ({
  fetchCapturedLeads: vi.fn(), fetchEndpoints: vi.fn(), fetchSubmissions: vi.fn(),
  createEndpoint: vi.fn(), setEndpointEnabled: vi.fn(),
  fetchArchivedReturnPacket: vi.fn(), resolveArchivedReturn: vi.fn(),
  fetchArchivedReturnBatchPacket: vi.fn(),
  resolveArchivedReturnBatch: vi.fn(),
}));

vi.mock("../../lib/archivedReturnBatch", () => ({
  fetchArchivedReturnBatchPacket, resolveArchivedReturnBatch,
}));

vi.mock("../../lib/leadCapture", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/leadCapture");
  return {
    ...actual,
    fetchCapturedLeads, fetchEndpoints, fetchSubmissions, createEndpoint, setEndpointEnabled,
    fetchArchivedReturnPacket, resolveArchivedReturn,
  };
});
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: async () => ({
          data:
            table === "client_campaigns"
              ? [{ id: "camp-1", name: "Winter garage push" }]
              : [{ id: "page-1", title: "Garage survey" }],
          error: null,
        }),
      });
      return chain;
    },
  },
}));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { LeadCapturePanel } from "./LeadCapturePanel";

const lead = (over: Record<string, unknown> = {}) => ({
  id: "lead-1", name: "Jay Okafor", email: "jay@example.test", phone: null,
  stage: "lead", source: "page_form", source_channel: "paid_search",
  consent_given_at: "2026-10-24T09:14:00Z",
  consent_wording: "I agree to Harbour Home contacting me about my enquiry.",
  source_client_campaign_id: "camp-1", source_page_id: "page-1",
  source_click_id: "gclid-abc123456789", source_utm: { utm_source: "google" },
  created_at: "2026-10-24T09:14:00Z", ...over,
});

const endpoint = (over: Record<string, unknown> = {}) => ({
  id: "end-1", client_id: "client-1", purpose: "page_form", token_hash: "a".repeat(64),
  campaign_id: "camp-1", page_id: "page-1", source_channel: "paid_search",
  magnet_version_id: null, consent_wording: "I agree.", enabled: true,
  expires_at: "2027-01-01T00:00:00Z", max_submissions: 500, submissions: 7,
  revoked_at: null, created_by: null,
  created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z", ...over,
});

const submission = (over: Record<string, unknown> = {}) => ({
  id: "sub-1", client_id: "client-1", endpoint_id: "end-1", name: "Jay Okafor",
  email: "jay@example.test", phone: null, message: null,
  consent_wording: "I agree.", consent_given_at: "2026-10-24T09:14:00Z",
  consent_evidence: {}, click_id: null, utm: null, idempotency_key: "k",
  status: "promoted", lead_id: "lead-1", rejected_reason: null,
  created_at: "2026-10-24T09:14:00Z", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchCapturedLeads.mockResolvedValue([lead()]);
  fetchEndpoints.mockResolvedValue({
    endpoints: [endpoint()],
    due: new Map([["end-1", { endpoint_id: "end-1", blocker: null }]]),
  });
  fetchSubmissions.mockResolvedValue([submission()]);
  createEndpoint.mockResolvedValue({ endpointId: "end-2", token: "f".repeat(64) });
  fetchArchivedReturnPacket.mockResolvedValue({
    source_hash: "a".repeat(64), submission_id: "sub-1", archived_lead_id: "arch-1",
    archived_name: "Jay Okafor", archived_stage: "shown",
    archived_email: "jay@example.test", archived_phone: null, archived_source: "page_form",
    archived_at: "2026-10-23T09:00:00Z", submitted_name: "Jay Okafor",
    submitted_email: "jay@example.test", submitted_phone: null,
    submitted_at: "2026-10-24T09:14:00Z", consent_wording: "I agree.",
    source_snapshot: { purpose: "page_form", source_channel: "paid_search" },
    route_package_id: "route-1", click_id: "click-1",
  });
  resolveArchivedReturn.mockResolvedValue("arch-1");
  fetchArchivedReturnBatchPacket.mockResolvedValue({
    archived_lead_id: "arch-1", archived_name: "Jay Okafor", source_hash: "b".repeat(64),
    source_count: 1, dm_count: 0, decision_state: "single_source",
    blocker: "One source is pending.", sources: [], dms: [],
  });
  resolveArchivedReturnBatch.mockResolvedValue("lead-new");
});

describe("who arrived", () => {
  it("shows the campaign, the channel and the click id behind a lead", async () => {
    render(<LeadCapturePanel />);
    expect(await screen.findByText("Jay Okafor")).toBeInTheDocument();
    // Scoped to the leads table: the endpoint below it legitimately shows the
    // same campaign and channel, because that is where this lead came from.
    const leads = within(screen.getAllByRole("table")[0]!);
    expect(leads.getByText("paid_search")).toBeInTheDocument();
    expect(leads.getByText("Winter garage push")).toBeInTheDocument();
    expect(leads.getByText("gclid-abc123456789")).toBeInTheDocument();
  });

  it("shows the words they agreed to rather than that they agreed", async () => {
    render(<LeadCapturePanel />);
    expect(
      await screen.findByText(/I agree to Harbour Home contacting me/),
    ).toBeInTheDocument();
  });

  it("counts leads by recorded consent, not by a source string", async () => {
    render(<LeadCapturePanel />);
    // A lead somebody typed in from a phone call has a source too.
    expect(await screen.findByText(/1 lead arrived from outside/)).toBeInTheDocument();
  });

  it("reads a returning person as one lead with several touches", async () => {
    fetchSubmissions.mockResolvedValue([
      submission(),
      submission({ id: "sub-2", idempotency_key: "k2" }),
    ]);
    render(<LeadCapturePanel />);
    expect(await screen.findByText("returning")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("says plainly when nobody has arrived", async () => {
    fetchCapturedLeads.mockResolvedValue([]);
    render(<LeadCapturePanel />);
    expect(
      await screen.findByText("Nobody has arrived from outside yet"),
    ).toBeInTheDocument();
  });
});

describe("the doors", () => {
  it("counts the open ones and shows the blocker on the rest", async () => {
    fetchEndpoints.mockResolvedValue({
      endpoints: [endpoint(), endpoint({ id: "end-2", enabled: false, submissions: 0 })],
      due: new Map([
        ["end-1", { endpoint_id: "end-1", blocker: null }],
        [
          "end-2",
          {
            endpoint_id: "end-2",
            blocker: "Switched off. Nothing posted here is accepted.",
          },
        ],
      ]),
    });
    render(<LeadCapturePanel />);
    expect(await screen.findByText(/1 of 2 doors open/)).toBeInTheDocument();
    expect(
      screen.getByText("Switched off. Nothing posted here is accepted."),
    ).toBeInTheDocument();
    expect(screen.getByText("Taking submissions")).toBeInTheDocument();
  });

  it("switches one off without touching the others", async () => {
    const user = userEvent.setup();
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Switch off" }));
    await waitFor(() => expect(setEndpointEnabled).toHaveBeenCalledWith("end-1", false));
  });

  it("requests exact review before opening a disabled intake door", async () => {
    const user = userEvent.setup();
    fetchEndpoints.mockResolvedValue({
      endpoints: [endpoint({ enabled: false, submissions: 0 })],
      due: new Map([["end-1", { endpoint_id: "end-1", blocker: "Switched off" }]]),
    });
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Request activation" }));
    await waitFor(() => expect(setEndpointEnabled).toHaveBeenCalledWith("end-1", true));
    expect(await screen.findByText(/Exact activation review requested/)).toBeInTheDocument();
  });

  it("hands back a new token once, and says why", async () => {
    const user = userEvent.setup();
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: "Open a capture link" }));
    await user.selectOptions(screen.getByLabelText(/What it is for/), "page_form");
    await user.type(
      screen.getByLabelText(/What they are agreeing to/),
      "I agree to being contacted about my enquiry.",
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));

    await waitFor(() => expect(createEndpoint).toHaveBeenCalled());
    expect(createEndpoint.mock.calls[0]![0]).toMatchObject({
      clientId: "client-1",
      purpose: "page_form",
    });
    expect(await screen.findByText("Capture link — copy it now")).toBeInTheDocument();
    expect(screen.getByText("f".repeat(64))).toBeInTheDocument();
  });

  it("sends campaign page forms to the route-bound Website Studio flow", async () => {
    const user = userEvent.setup();
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: "Open a capture link" }));
    await user.selectOptions(screen.getByLabelText(/What it is for/), "page_form");
    await user.type(screen.getByLabelText(/What they are agreeing to/),
      "I agree to being contacted about my enquiry.");
    await user.selectOptions(screen.getByLabelText(/Attribute to campaign/), "camp-1");
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Website Studio");
    expect(createEndpoint).not.toHaveBeenCalled();
  });
});

describe("what did not become a lead", () => {
  it("keeps a merged submission visible rather than losing it", async () => {
    fetchSubmissions.mockResolvedValue([
      submission({ id: "sub-9", status: "rejected", rejected_reason: "No consent given." }),
    ]);
    render(<LeadCapturePanel />);
    expect(
      await screen.findByText("Submissions needing attention"),
    ).toBeInTheDocument();
    expect(screen.getByText("No consent given.")).toBeInTheDocument();
  });

  it("hides that section when everything became a lead", async () => {
    render(<LeadCapturePanel />);
    await screen.findByText("Jay Okafor");
    expect(
      screen.queryByText("Submissions needing attention"),
    ).not.toBeInTheDocument();
  });

  it("shows the exact archived-return packet and records the selected review", async () => {
    const user = userEvent.setup();
    fetchSubmissions.mockResolvedValue([submission({
      status: "received", lead_id: null, archive_match_lead_id: "arch-1",
    })]);
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: "Review return" }));
    expect(await screen.findByText(/Captured source: paid_search/)).toBeInTheDocument();
    expect(screen.getByText(/Consent: I agree/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Reviewed outcome/), "recover");
    await user.type(screen.getByLabelText(/Reason for this decision/),
      "Same continuing customer relationship");
    await user.click(screen.getByRole("button", { name: "Record AAL2 decision" }));
    await waitFor(() => expect(resolveArchivedReturn).toHaveBeenCalledWith({
      submissionId: "sub-1", action: "recover", sourceHash: "a".repeat(64),
      reason: "Same continuing customer relationship",
    }));
  });

  it("holds a form decision when another arrival shares the archived identity", async () => {
    fetchSubmissions.mockResolvedValue([submission({
      status: "received", lead_id: null, archive_match_lead_id: "arch-1",
    })]);
    fetchArchivedReturnBatchPacket.mockResolvedValue({
      archived_lead_id: "arch-1", archived_name: "Jay Okafor", source_hash: "c".repeat(64),
      source_count: 2, dm_count: 1, decision_state: "grouped_hold",
      blocker: "All arrivals need one exact coordinated AAL2 identity decision.",
      sources: [
        { kind: "form", submission_id: "sub-1", submitted_name: "Jay Okafor" },
        { kind: "sales_agent", conversation_id: "conv-2", current_name: "Jay returns" },
      ],
      dms: [{ conversation_id: "dm-3", platform: "instagram", last_inbound_at: null }],
    });
    render(<LeadCapturePanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Review return" }));
    expect(await screen.findByRole("dialog", { name: "Related archived-contact arrivals" })).toBeInTheDocument();
    expect(screen.getByText("Jay returns")).toBeInTheDocument();
    expect(screen.getByText(/Held instagram DM/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record AAL2 decision" })).not.toBeInTheDocument();
    expect(fetchArchivedReturnPacket).not.toHaveBeenCalled();
  });

  it("reviews a grouped form and sales return through one decision", async () => {
    fetchSubmissions.mockResolvedValue([submission({
      status: "received", lead_id: null, archive_match_lead_id: "arch-1",
    })]);
    fetchArchivedReturnBatchPacket.mockResolvedValue({
      archived_lead_id: "arch-1", archived_name: "Jay Okafor", source_hash: "d".repeat(64),
      source_count: 2, dm_count: 0, decision_state: "grouped_hold",
      blocker: "All arrivals need one exact coordinated AAL2 identity decision.",
      sources: [
        { kind: "form", submission_id: "sub-1", submitted_name: "Jay Okafor",
          consent_wording: "I agree." },
        { kind: "sales_agent", conversation_id: "conv-2", current_name: "Jay returns" },
      ], dms: [],
    });
    const user = userEvent.setup();
    render(<LeadCapturePanel />);
    await user.click(await screen.findByRole("button", { name: "Review return" }));
    expect(await screen.findByText(/Consent: I agree/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Reviewed outcome" }), "new_lead");
    await user.selectOptions(screen.getByRole("combobox", { name: "Primary source for attribution" }), "form:sub-1");
    await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }),
      "This is one new relationship");
    await user.click(screen.getByRole("button", { name: "Record grouped AAL2 decision" }));
    await waitFor(() => expect(resolveArchivedReturnBatch).toHaveBeenCalledWith({
      archivedLeadId: "arch-1", action: "new_lead", sourceHash: "d".repeat(64),
      reason: "This is one new relationship", primaryKind: "form", primaryId: "sub-1",
    }));
    expect(resolveArchivedReturn).not.toHaveBeenCalled();
  });
});
