import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules this screen could quietly get wrong.
 *
 * An approval is given against a version, not a magnet, so a magnet with
 * three versions where the second is approved has to read as "v2 live" and
 * not simply as "approved". A capture token is readable exactly once, so the
 * screen has to show it and say so. And a form that promises a magnet while
 * naming no version is a promise nobody can keep, which has to be visible
 * rather than inferred from an empty column.
 */

const {
  fetchMagnets, fetchVersions, fetchApprovals, fetchDeliveriesDue, fetchEndpoints,
  fetchSubmissions, fetchDeliverySwitch, setDeliveryEnabled, requestApproval,
  decideApproval, revokeApproval, createEndpoint, setEndpointEnabled,
} = vi.hoisted(() => ({
  fetchMagnets: vi.fn(), fetchVersions: vi.fn(), fetchApprovals: vi.fn(),
  fetchDeliveriesDue: vi.fn(), fetchEndpoints: vi.fn(), fetchSubmissions: vi.fn(),
  fetchDeliverySwitch: vi.fn(), setDeliveryEnabled: vi.fn(), requestApproval: vi.fn(),
  decideApproval: vi.fn(), revokeApproval: vi.fn(), createEndpoint: vi.fn(),
  setEndpointEnabled: vi.fn(),
}));

vi.mock("../../lib/leadMagnets", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/leadMagnets");
  return {
    ...actual,
    fetchMagnets, fetchVersions, fetchApprovals, fetchDeliveriesDue,
    fetchDeliverySwitch, setDeliveryEnabled, requestApproval,
    decideApproval, revokeApproval,
  };
});
// The endpoint and submission reads are shared with Sales OS, so they live in
// their own module rather than in the magnet's.
vi.mock("../../lib/leadCapture", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/leadCapture");
  return { ...actual, fetchEndpoints, fetchSubmissions, createEndpoint, setEndpointEnabled };
});
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: async () => ({ data: [{ id: "camp-1", name: "Winter garage push" }], error: null }),
      });
      return chain;
    },
  },
}));
vi.mock("react-router-dom", () => ({ useParams: () => ({ clientId: "client-1" }) }));

import { LeadMagnetStudioPanel } from "./LeadMagnetStudioPanel";

const magnet = {
  id: "mag-1", client_id: "client-1", name: "Garage conversion cost guide",
  objective: "Turn survey curiosity into a booking", audience: null, format: "pdf_guide",
  campaign_id: "camp-1", offer_version_id: null, archived_at: null,
  created_by: null, created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z",
};
const version = (over: Record<string, unknown> = {}) => ({
  id: "ver-1", magnet_id: "mag-1", client_id: "client-1", version: 1,
  storage_path: "magnets/cost-guide-v1.pdf", content_sha256: "b".repeat(64),
  file_bytes: 284113, media_type: "application/pdf", delivery_channel: "email",
  delivery_subject: "Your cost guide", delivery_body: "Here it is.",
  created_by_job_id: null, created_by: null, created_at: "2026-10-24T09:00:00Z", ...over,
});
const approval = (over: Record<string, unknown> = {}) => ({
  id: "app-1", client_id: "client-1", magnet_version_id: "ver-1",
  payload_hash: "c".repeat(64), scope: { file: "magnets/cost-guide-v1.pdf", channel: "email", subject: "Your cost guide" },
  status: "pending", requested_at: "2026-10-24T09:05:00Z", requested_by: null,
  decided_at: null, decided_by: null, rejection_reason: null,
  revoked_at: null, revoked_reason: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMagnets.mockResolvedValue([magnet]);
  fetchVersions.mockResolvedValue([version()]);
  fetchApprovals.mockResolvedValue([]);
  fetchDeliveriesDue.mockResolvedValue([]);
  fetchEndpoints.mockResolvedValue({ endpoints: [], due: new Map() });
  fetchSubmissions.mockResolvedValue([]);
  fetchDeliverySwitch.mockResolvedValue(false);
  createEndpoint.mockResolvedValue({ endpointId: "end-1", token: "f".repeat(64) });
});

describe("which version is live", () => {
  it("names the approved version rather than saying only approved", async () => {
    fetchVersions.mockResolvedValue([version(), version({ id: "ver-2", version: 2 })]);
    fetchApprovals.mockResolvedValue([
      approval({ id: "app-2", magnet_version_id: "ver-2", status: "approved", decided_at: "2026-10-24T10:00:00Z", decided_by: "u1" }),
    ]);
    render(<LeadMagnetStudioPanel tab="magnets" />);

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });

  it("says what is stopping it when no version is approved", async () => {
    render(<LeadMagnetStudioPanel tab="magnets" />);
    expect(
      await screen.findByText("Nobody has been asked to approve it."),
    ).toBeInTheDocument();
  });

  it("says a magnet with no file cannot promise anything", async () => {
    fetchVersions.mockResolvedValue([]);
    render(<LeadMagnetStudioPanel tab="magnets" />);
    expect(await screen.findByText("No file has been uploaded yet.")).toBeInTheDocument();
  });

  it("offers approval of the newest version only when nothing is pending", async () => {
    const user = userEvent.setup();
    render(<LeadMagnetStudioPanel tab="magnets" />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Ask for approval of v1" }));
    await waitFor(() => expect(requestApproval).toHaveBeenCalledWith("ver-1"));
  });

  it("does not offer it again while a decision is outstanding", async () => {
    const user = userEvent.setup();
    fetchApprovals.mockResolvedValue([approval()]);
    render(<LeadMagnetStudioPanel tab="magnets" />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    expect(
      screen.queryByRole("menuitem", { name: /Ask for approval/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the one decision", () => {
  it("shows the file, the hash and the route a person is agreeing to", async () => {
    fetchApprovals.mockResolvedValue([approval()]);
    render(<LeadMagnetStudioPanel tab="delivery" />);

    expect(await screen.findByText("magnets/cost-guide-v1.pdf")).toBeInTheDocument();
    expect(screen.getByText(/^c{24}…$/)).toBeInTheDocument();
    expect(screen.getByText("Garage conversion cost guide v1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve this file and route" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("app-1", true));
  });

  it("keeps the client switch separate from any one approval", async () => {
    render(<LeadMagnetStudioPanel tab="delivery" />);
    expect(
      await screen.findByText("Magnet delivery is off for this client"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Opt-ins are still captured and still owe a file/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(setDeliveryEnabled).toHaveBeenCalledWith("client-1", true));
  });

  it("shows the blocker the database gave for an owed magnet", async () => {
    fetchDeliveriesDue.mockResolvedValue([
      {
        delivery_id: "del-1", client_id: "client-1", submission_id: "sub-1", lead_id: "lead-1",
        magnet_version_id: "ver-1", magnet_name: "Garage conversion cost guide",
        channel: "email", recipient: "jay@example.test", status: "queued", attempts: 2,
        provider_ref: null, last_error: null,
        blocker: "The file or the message changed after approval. Ask again.",
      },
    ]);
    render(<LeadMagnetStudioPanel tab="delivery" />);
    expect(
      await screen.findByText("The file or the message changed after approval. Ask again."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("requires a reason before revoking", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("  ");
    fetchApprovals.mockResolvedValue([
      approval({ status: "approved", decided_at: "2026-10-24T10:00:00Z", decided_by: "u1" }),
    ]);
    render(<LeadMagnetStudioPanel tab="delivery" />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(revokeApproval).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});

describe("opting in", () => {
  it("shows a new token once and says why", async () => {
    const user = userEvent.setup();
    render(<LeadMagnetStudioPanel tab="optins" />);
    await user.click(
      await screen.findByRole("button", { name: /Open a link for Garage conversion cost guide v1/ }),
    );
    await user.type(
      screen.getByLabelText(/What they are agreeing to/),
      "I agree to being emailed the guide.",
    );
    await user.click(screen.getByRole("button", { name: "Open it" }));

    await waitFor(() => expect(createEndpoint).toHaveBeenCalled());
    expect(createEndpoint.mock.calls[0]![0]).toMatchObject({
      clientId: "client-1",
      purpose: "magnet_optin",
      magnetVersionId: "ver-1",
    });
    expect(await screen.findByText("Capture link — copy it now")).toBeInTheDocument();
    expect(screen.getByText("f".repeat(64))).toBeInTheDocument();
    expect(screen.getByText(/one time it can be read/)).toBeInTheDocument();
  });

  it("flags a form that promises a magnet while naming no version", async () => {
    fetchEndpoints.mockResolvedValue({
      endpoints: [
        {
          id: "end-1", client_id: "client-1", purpose: "magnet_optin", token_hash: "a".repeat(64),
          campaign_id: null, page_id: null, source_channel: null, magnet_version_id: null,
          consent_wording: "I agree.", enabled: true, expires_at: "2027-01-01T00:00:00Z",
          max_submissions: 500, submissions: 3, revoked_at: null, created_by: null,
          created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T09:00:00Z",
        },
      ],
      due: new Map([["end-1", { endpoint_id: "end-1", blocker: null }]]),
    });
    render(<LeadMagnetStudioPanel tab="optins" />);
    expect(
      await screen.findByText("Promises a magnet but names no version."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 / 500")).toBeInTheDocument();
  });

  it("shows the wording each person actually agreed to", async () => {
    fetchSubmissions.mockResolvedValue([
      {
        id: "sub-1", client_id: "client-1", endpoint_id: "end-1", name: "Jay Okafor",
        email: "jay@example.test", phone: null, message: null,
        consent_wording: "I agree to Harbour Home emailing me the guide and contacting me about it.",
        consent_given_at: "2026-10-24T09:14:00Z", consent_evidence: {},
        click_id: null, utm: null, idempotency_key: "k", status: "promoted",
        lead_id: "lead-1", rejected_reason: null, created_at: "2026-10-24T09:14:00Z",
      },
    ]);
    render(<LeadMagnetStudioPanel tab="optins" />);
    expect(await screen.findByText("Jay Okafor")).toBeInTheDocument();
    expect(screen.getByText("given")).toBeInTheDocument();
    // The words, not a tick.
    expect(screen.getByText(/I agree to Harbour Home emailing me/)).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });
});
