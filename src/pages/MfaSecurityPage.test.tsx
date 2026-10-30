import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useAuth, listFactors, getAAL, enroll, challengeAndVerify, unenroll } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listFactors: vi.fn(),
  getAAL: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  unenroll: vi.fn(),
}));
vi.mock("../context/auth", () => ({ useAuth }));
vi.mock("../lib/supabase", () => ({ supabase: { auth: { mfa: {
  listFactors, getAuthenticatorAssuranceLevel: getAAL, enroll, challengeAndVerify, unenroll,
} } } }));

import { MfaSecurityPage } from "./MfaSecurityPage";

const verified = {
  id: "factor-1", factor_type: "totp", status: "verified", friendly_name: "Phone app",
  created_at: "2026-10-30", updated_at: "2026-10-30",
};

function pageTree(returnTo?: string) {
  return <MemoryRouter initialEntries={[{ pathname: "/security/mfa", state: returnTo ? { returnTo } : null }]}>
    <Routes>
      <Route path="/security/mfa" element={<MfaSecurityPage />} />
      <Route path="/login" element={<p>Login page</p>} />
    </Routes>
  </MemoryRouter>;
}

function openPage() {
  return render(pageTree());
}

beforeEach(() => {
  vi.resetAllMocks();
  useAuth.mockReturnValue({
    loading: false,
    session: { user: { id: "user-1" }, access_token: "first-session" },
    profile: { id: "user-1", role: "admin" },
  });
  getAAL.mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
  listFactors.mockResolvedValue({ data: { all: [] }, error: null });
  enroll.mockResolvedValue({ data: { id: "new-factor", totp: { secret: "TESTSECRET123" } }, error: null });
  challengeAndVerify.mockResolvedValue({ data: {}, error: null });
  unenroll.mockResolvedValue({ data: {}, error: null });
});

describe("MFA security page", () => {
  it("enrolls a first TOTP factor in memory and confirms AAL2 after its code", async () => {
    const user = userEvent.setup();
    listFactors.mockResolvedValueOnce({ data: { all: [] }, error: null })
      .mockResolvedValue({ data: { all: [verified] }, error: null });
    getAAL.mockResolvedValueOnce({ data: { currentLevel: "aal1" }, error: null })
      .mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
    openPage();

    await user.click(await screen.findByRole("button", { name: "Start TOTP setup" }));
    expect(screen.getByLabelText("Authenticator setup secret")).toHaveTextContent("TESTSECRET123");
    await user.type(screen.getByRole("textbox", { name: "One-time code" }), "123456");
    await user.click(screen.getByRole("button", { name: "Finish TOTP setup" }));

    await waitFor(() => expect(screen.getByText("Current session: AAL2")).toBeInTheDocument());
    expect(screen.queryByText("TESTSECRET123")).not.toBeInTheDocument();
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "new-factor", code: "123456" });
  });

  it("challenges an existing verified factor before allowing another enrollment", async () => {
    const user = userEvent.setup();
    listFactors.mockResolvedValue({ data: { all: [verified] }, error: null });
    getAAL.mockResolvedValueOnce({ data: { currentLevel: "aal1" }, error: null })
      .mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
    openPage();

    expect(await screen.findByText("Current session: AAL1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start TOTP setup" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "One-time code" }), "654321");
    await user.click(screen.getByRole("button", { name: "Verify code" }));

    await waitFor(() => expect(screen.getByText("Current session: AAL2")).toBeInTheDocument());
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "factor-1", code: "654321" });
    expect(enroll).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Start TOTP setup" })).toBeInTheDocument();
  });

  it("fails closed when factor inventory cannot be verified", async () => {
    listFactors.mockResolvedValue({ data: null, error: new Error("unavailable") });
    openPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify your security settings");
    expect(screen.queryByRole("button", { name: /TOTP setup|Verify code/ })).not.toBeInTheDocument();
    expect(enroll).not.toHaveBeenCalled();
  });

  it("never carries an in-memory setup secret across a same-route account switch", async () => {
    const user = userEvent.setup();
    const page = openPage();
    await user.click(await screen.findByRole("button", { name: "Start TOTP setup" }));
    expect(screen.getByLabelText("Authenticator setup secret")).toHaveTextContent("TESTSECRET123");

    useAuth.mockReturnValue({
      loading: false,
      session: { user: { id: "user-2" }, access_token: "second-session" },
      profile: { id: "user-2", role: "client" },
    });
    page.rerender(pageTree());
    expect(screen.queryByLabelText("Authenticator setup secret")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Start TOTP setup" })).toBeInTheDocument();
  });

  it("drops a setup secret when the same user receives a new session", async () => {
    const user = userEvent.setup();
    const page = openPage();
    await user.click(await screen.findByRole("button", { name: "Start TOTP setup" }));
    expect(screen.getByLabelText("Authenticator setup secret")).toHaveTextContent("TESTSECRET123");

    useAuth.mockReturnValue({
      loading: false,
      session: { user: { id: "user-1" }, access_token: "replacement-session" },
      profile: { id: "user-1", role: "admin" },
    });
    page.rerender(pageTree());
    expect(screen.queryByLabelText("Authenticator setup secret")).not.toBeInTheDocument();
  });

  it("discards an unfinished setup instead of accumulating unusable factors", async () => {
    const user = userEvent.setup();
    const page = openPage();
    await user.click(await screen.findByRole("button", { name: "Start TOTP setup" }));
    await user.click(screen.getByRole("button", { name: "Cancel and discard setup" }));
    await waitFor(() => expect(unenroll).toHaveBeenCalledWith({ factorId: "new-factor" }));
    expect(screen.queryByLabelText("Authenticator setup secret")).not.toBeInTheDocument();
    page.unmount();
  });

  it("requires clearing an orphaned unverified factor before another enrollment", async () => {
    const user = userEvent.setup();
    const orphan = { ...verified, id: "orphan-factor", status: "unverified" };
    listFactors.mockResolvedValueOnce({ data: { all: [orphan] }, error: null })
      .mockResolvedValue({ data: { all: [] }, error: null });
    openPage();
    const discard = await screen.findByRole("button", { name: "Discard unfinished setup (Phone app)" });
    expect(screen.queryByRole("button", { name: "Start TOTP setup" })).not.toBeInTheDocument();
    await user.click(discard);
    expect(unenroll).toHaveBeenCalledWith({ factorId: "orphan-factor" });
    expect(await screen.findByRole("button", { name: "Start TOTP setup" })).toBeInTheDocument();
  });

  it("offers only a safe Approval Inbox return route", async () => {
    const page = render(pageTree("/approvals?status=pending"));
    expect(await screen.findByRole("link", { name: "Return to Approval Inbox" }))
      .toHaveAttribute("href", "/approvals?status=pending");
    page.unmount();
    render(pageTree("//outside.example/approvals"));
    expect(screen.queryByRole("link", { name: "Return to Approval Inbox" })).not.toBeInTheDocument();
  });

  it("does not render factors for a missing authenticated profile", async () => {
    useAuth.mockReturnValue({ loading: false, session: null, profile: null });
    openPage();
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(listFactors).not.toHaveBeenCalled();
  });
});
