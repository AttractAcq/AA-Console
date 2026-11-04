import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules this screen could quietly get wrong.
 *
 * An approval is given against a version, not a magnet, so a magnet with
 * three versions where the second is approved has to read as "v2 live" and
 * not simply as "approved".
 *
 * And the decision has to show what the APPROVAL recorded rather than what
 * the version row says now. The two agree until someone re-exports the file
 * or the message, and the gap between them is the whole reason the
 * "changed after approval" blocker exists. A screen that restated the current
 * row would hide exactly the case the gate is for.
 *
 * Collapsing four tabs into one page (phase 3 item 7) is where coverage could
 * be lost rather than moved, so there are tests here for the two things that
 * must NOT come back: the delivery switch, which belongs to the Dashboard
 * panel, and the capture-link form, which belongs to Sales OS -> Capture.
 */

const {
  fetchMagnets, fetchVersions, fetchApprovals, fetchDeliveriesDue, fetchEndpoints,
  fetchSubmissions, requestApproval, decideApproval, revokeApproval,
} = vi.hoisted(() => ({
  fetchMagnets: vi.fn(), fetchVersions: vi.fn(), fetchApprovals: vi.fn(),
  fetchDeliveriesDue: vi.fn(), fetchEndpoints: vi.fn(), fetchSubmissions: vi.fn(),
  requestApproval: vi.fn(), decideApproval: vi.fn(), revokeApproval: vi.fn(),
}));

vi.mock("../../lib/leadMagnets", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/leadMagnets");
  return {
    ...actual,
    fetchMagnets, fetchVersions, fetchApprovals, fetchDeliveriesDue,
    requestApproval, decideApproval, revokeApproval,
  };
});
// The endpoint and submission reads are shared with Sales OS, so they live in
// their own module rather than in the magnet's. This page only counts them.
vi.mock("../../lib/leadCapture", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../lib/leadCapture");
  return { ...actual, fetchEndpoints, fetchSubmissions };
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

/** Which row is open, since IndexDetail keeps that in the URL. */
const search = { value: "" };
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  useSearchParams: () => [new URLSearchParams(search.value), vi.fn()],
}));

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
const dueRow = (over: Record<string, unknown> = {}) => ({
  delivery_id: "del-1", client_id: "client-1", submission_id: "sub-1", lead_id: "lead-1",
  magnet_version_id: "ver-1", magnet_name: "Garage conversion cost guide",
  channel: "email", recipient: "jay@example.test", status: "queued", attempts: 2,
  provider_ref: null, last_error: null,
  blocker: "The file or the message changed after approval. Ask again.", ...over,
});

/** The magnet's row open, which is where every decision now lives. */
const openRow = () => {
  search.value = "magnet=mag-1";
};

beforeEach(() => {
  vi.clearAllMocks();
  search.value = "";
  fetchMagnets.mockResolvedValue([magnet]);
  fetchVersions.mockResolvedValue([version()]);
  fetchApprovals.mockResolvedValue([]);
  fetchDeliveriesDue.mockResolvedValue([]);
  fetchEndpoints.mockResolvedValue({ endpoints: [], due: new Map() });
  fetchSubmissions.mockResolvedValue([]);
});

describe("which version is live", () => {
  it("names the approved version rather than saying only approved", async () => {
    fetchVersions.mockResolvedValue([version(), version({ id: "ver-2", version: 2 })]);
    fetchApprovals.mockResolvedValue([
      approval({ id: "app-2", magnet_version_id: "ver-2", status: "approved", decided_at: "2026-10-24T10:00:00Z", decided_by: "u1" }),
    ]);
    render(<LeadMagnetStudioPanel />);

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });

  it("says what is stopping it when no version is approved", async () => {
    render(<LeadMagnetStudioPanel />);
    expect(
      await screen.findByText("Nobody has been asked to approve it."),
    ).toBeInTheDocument();
  });

  it("says a magnet with no file cannot promise anything", async () => {
    fetchVersions.mockResolvedValue([]);
    render(<LeadMagnetStudioPanel />);
    expect(await screen.findByText("No file has been uploaded yet.")).toBeInTheDocument();
  });

  it("offers approval of the newest version only when nothing is pending", async () => {
    const user = userEvent.setup();
    render(<LeadMagnetStudioPanel />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    await user.click(await screen.findByRole("menuitem", { name: "Ask for approval of v1" }));
    await waitFor(() => expect(requestApproval).toHaveBeenCalledWith("ver-1"));
  });

  it("does not offer it again while a decision is outstanding", async () => {
    const user = userEvent.setup();
    fetchApprovals.mockResolvedValue([approval()]);
    render(<LeadMagnetStudioPanel />);
    await user.click(await screen.findByRole("button", { name: /^Actions for / }));
    expect(
      screen.queryByRole("menuitem", { name: /Ask for approval/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the one decision", () => {
  it("shows the file, the hash and the route a person is agreeing to", async () => {
    openRow();
    fetchApprovals.mockResolvedValue([approval()]);
    render(<LeadMagnetStudioPanel />);

    // The approval's own recorded scope, not a restatement of the version row.
    expect(await screen.findByText("magnets/cost-guide-v1.pdf")).toBeInTheDocument();
    expect(screen.getByText(/^c{24}…$/)).toBeInTheDocument();
    // And the words that carry it, which is half of what is being approved.
    expect(screen.getByText("Here it is.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Approve this file and route" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("app-1", true));
  });

  it("offers no decision until a row is open", async () => {
    fetchApprovals.mockResolvedValue([approval()]);
    render(<LeadMagnetStudioPanel />);
    await screen.findByText("Garage conversion cost guide");
    expect(
      screen.queryByRole("button", { name: "Approve this file and route" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Choose a magnet to see its versions and decide on them."),
    ).toBeInTheDocument();
  });

  it("requires a reason before revoking", async () => {
    openRow();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("  ");
    fetchApprovals.mockResolvedValue([
      approval({ status: "approved", decided_at: "2026-10-24T10:00:00Z", decided_by: "u1" }),
    ]);
    render(<LeadMagnetStudioPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(revokeApproval).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});

describe("what is owed", () => {
  it("shows the blocker the database gave, on the magnet it belongs to", async () => {
    openRow();
    fetchDeliveriesDue.mockResolvedValue([dueRow()]);
    render(<LeadMagnetStudioPanel />);
    expect(
      await screen.findByText("The file or the message changed after approval. Ask again."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("scopes owed rows by version rather than by magnet name", async () => {
    // Two magnets may legitimately share a name, and a rename would silently
    // empty a name-matched list. This row names the right magnet and the
    // wrong version, so a name match would wrongly show it.
    openRow();
    fetchDeliveriesDue.mockResolvedValue([
      dueRow({ magnet_version_id: "ver-elsewhere" }),
    ]);
    render(<LeadMagnetStudioPanel />);
    await screen.findByText("Versions");
    expect(screen.getByText("Nobody is owed this magnet")).toBeInTheDocument();
  });

  it("counts what is owed on the row, so the table says where to look", async () => {
    fetchDeliveriesDue.mockResolvedValue([dueRow(), dueRow({ delivery_id: "del-2" })]);
    render(<LeadMagnetStudioPanel />);
    await screen.findByText("Garage conversion cost guide");
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("what this page must not grow back", () => {
  it("does not carry the delivery switch, which belongs to the Dashboard panel", async () => {
    render(<LeadMagnetStudioPanel />);
    await screen.findByText("Garage conversion cost guide");
    expect(screen.queryByRole("button", { name: /Switch (on|off)/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Magnet delivery is/)).not.toBeInTheDocument();
  });

  it("does not carry the capture-link form, which belongs to Sales OS", async () => {
    openRow();
    render(<LeadMagnetStudioPanel />);
    await screen.findByText("Versions");
    expect(screen.queryByRole("button", { name: /Open a link for/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Capture link — copy it now")).not.toBeInTheDocument();
  });
});
