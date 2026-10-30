import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, update, callRuntime, rpc, assurance } = vi.hoisted(() => ({
  from: vi.fn(), update: vi.fn(), callRuntime: vi.fn(), rpc: vi.fn(), assurance: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc, auth: { mfa: { getAuthenticatorAssuranceLevel: assurance } } } }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { TeamCategoryPanel } from "./TeamCategoryPanel";

const member = {
  id: "member-1", name: "Editor 1", initials: "E1", engagement: "contractor", active: true,
  given_name: "", family_name: "", preferred_name: "", legal_name: "", email: "old@example.com",
  phone: "", address_line1: "", address_line2: "", address_city: "", address_region: "",
  address_postal_code: "", address_country: "", company_name: "", tax_id: "", profile_notes: "",
  personal_info: null, contact_info: null,
};

function query(data: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data, error: null }),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  callRuntime.mockResolvedValue({ ok: true, invitations: [] });
  rpc.mockResolvedValue({ error: null });
  assurance.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
  from.mockReturnValue({
    ...query([member]),
    update: (value: unknown) => {
      update(value);
      const chain = { eq: () => chain, then: (done: (result: { error: null }) => void) => Promise.resolve({ error: null }).then(done) };
      return chain;
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

const show = () => render(<MemoryRouter><TeamCategoryPanel category="editors" /></MemoryRouter>);

describe("controlled team invitations", () => {
  it("requests a one-recipient roster invitation and keeps the review in Inbox", async () => {
    callRuntime.mockImplementation(async (path: string) => path.endsWith("/list")
      ? { ok: true, invitations: [] }
      : { ok: true, requestId: "request-1", status: "requested" });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Invite Editor 1" }));
    await userEvent.type(screen.getByLabelText("Recipient email"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Request invitation" }));
    await waitFor(() => expect(callRuntime).toHaveBeenCalledWith("/admin/invitations/request",
      expect.objectContaining({
        email: "new@example.com", targetRole: "employee", memberId: "member-1",
        idempotencyKey: expect.any(String),
      })));
    expect(await screen.findByText(/awaiting exact-version approval/i)).toBeInTheDocument();
  });

  it("shows a pending card and prevents a second request", async () => {
    callRuntime.mockResolvedValue({ ok: true, invitations: [{
      id: "request-1", target_member_id: "member-1", recipient_email: "new@example.com",
      status: "requested", expires_at: "2035-01-01T00:00:00Z", payload_hash: "a".repeat(64),
    }] });
    show();
    expect(await screen.findByText(/Awaiting exact-version approval/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Approval Inbox/ })).toHaveAttribute("href", "/approvals");
    expect(screen.queryByRole("button", { name: "Invite Editor 1" })).not.toBeInTheDocument();
  });

  it("holds ambiguous provider outcomes without offering another invite", async () => {
    callRuntime.mockResolvedValue({ ok: true, invitations: [{
      id: "request-1", target_member_id: "member-1", recipient_email: "new@example.com",
      status: "reconcile", expires_at: "2020-01-01T00:00:00Z", payload_hash: "a".repeat(64),
    }] });
    show();
    expect(await screen.findByText(/manual review; do not resend/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Editor 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resolve uncertain send/ })).toBeInTheDocument();
  });

  it("shows every invitation for the member, including a held uncertain send", async () => {
    callRuntime.mockResolvedValue({ ok: true, invitations: [
      { id: "old", target_member_id: "member-1", recipient_email: "old-invite@example.com",
        status: "cancelled", expires_at: "2020-01-01T00:00:00Z", payload_hash: "a".repeat(64) },
      { id: "current", target_member_id: "member-1", recipient_email: "current@example.com",
        status: "sending", expires_at: "2035-01-01T00:00:00Z", payload_hash: "b".repeat(64) },
    ] });
    show();
    expect(await screen.findByText(/old-invite@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/current@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Editor 1" })).not.toBeInTheDocument();
  });

  it("keeps a retired member's stale invitation visible for cancellation", async () => {
    from.mockReturnValue({ ...query([{ ...member, active: false }]) });
    callRuntime.mockResolvedValue({ ok: true, invitations: [{
      id: "request-1", target_member_id: "member-1", recipient_email: "new@example.com",
      status: "requested", expires_at: "2035-01-01T00:00:00Z", payload_hash: "a".repeat(64),
    }] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: /Show retired/ }));
    expect(screen.getByText(/new@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel invitation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Editor 1" })).not.toBeInTheDocument();
  });

  it("requires retained evidence and AAL2 to resolve a crashed send", async () => {
    callRuntime.mockResolvedValue({ ok: true, invitations: [{
      id: "request-1", target_member_id: "member-1", recipient_email: "new@example.com",
      status: "sending", expires_at: "2035-01-01T00:00:00Z", payload_hash: "a".repeat(64),
    }] });
    vi.spyOn(window, "prompt").mockReturnValueOnce("provider-audit/no-send")
      .mockReturnValueOnce("c".repeat(64))
      .mockReturnValueOnce("Provider audit proves no send");
    show();
    await userEvent.click(await screen.findByRole("button", { name: /Resolve uncertain send/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      "resolve_console_invitation_uncertain_v6", {
        p_request_id: "request-1", p_expected_hash: "a".repeat(64),
        p_evidence_ref: "provider-audit/no-send", p_evidence_sha256: "c".repeat(64),
        p_reason: "Provider audit proves no send",
      }));
  });

  it("requires AAL2 and a reason to cancel through the owning RPC", async () => {
    callRuntime.mockResolvedValue({ ok: true, invitations: [{
      id: "request-1", target_member_id: "member-1", recipient_email: "new@example.com",
      status: "requested", expires_at: "2035-01-01T00:00:00Z", payload_hash: "a".repeat(64),
    }] });
    vi.spyOn(window, "prompt").mockReturnValue("Wrong recipient");
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel invitation" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("cancel_console_invitation_v6",
      { p_request_id: "request-1", p_reason: "Wrong recipient" }));
  });
});

describe("team profile management", () => {
  it("edits the real roster name and contact fields", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const name = screen.getByLabelText(/Display name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Jordan Smith");
    const email = screen.getByLabelText("Email");
    await userEvent.clear(email);
    await userEvent.type(email, "jordan@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Jordan Smith", email: "jordan@example.com" })));
  });

  it("retires a contractor without deleting history", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Past work and payments will remain"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ active: false }));
  });

  it("does not retire when confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));
    expect(update).not.toHaveBeenCalled();
  });
});

// The dialog used to say "they will leave the active roster and lose team
// access". Production does not revoke access: migration 127 adds `tm.active` to
// the four client-access functions and is not applied, so a retired member
// keeps every client they were assigned to. Retiring still does real work, so
// the control stays and the wording tells the truth instead.
describe("what retiring actually promises", () => {
  it("does not claim access is lost", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));

    const asked = vi.mocked(window.confirm).mock.calls[0]![0] as string;
    expect(asked).not.toMatch(/lose team access/i);
    expect(asked).toMatch(/not revoked yet/i);
    expect(asked).toMatch(/clear their client assignments/i);
    // The part that is true stays: they do come off the roster and briefs stop.
    expect(asked).toMatch(/stop being sent briefs/i);
  });

  it("repeats it on the retired list, for anyone who clicked through", async () => {
    from.mockReturnValue({
      ...query([{ ...member, id: "member-2", name: "Editor 2", active: false }]),
      update: () => {
        const chain = { eq: () => chain, then: (done: (result: { error: null }) => void) => Promise.resolve({ error: null }).then(done) };
        return chain;
      },
    });
    show();

    await userEvent.click(await screen.findByRole("button", { name: /Show retired \(1\)/ }));
    expect(screen.getByText(/does not\s+yet revoke their sign-in/i)).toBeInTheDocument();
  });
});
