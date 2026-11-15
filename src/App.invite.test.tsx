import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const INVITE_PATH = `/invite/accept?request=${REQUEST}`;
const AUTH_HASH = "#access_token=invite-token&refresh_token=refresh-token&type=invite";

const gate = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  profile: null as null | {
    id: string;
    role: string;
    full_name: string | null;
    email: string | null;
    employee_category: null;
  },
  signOut: vi.fn(async () => ({ error: null })),
}));

const runtime = vi.hoisted(() => ({
  callRuntime: vi.fn(async () => ({
    invitation: {
      recipientEmail: "invitee@example.com",
      targetRole: "employee" as const,
      fullName: "Ada Invitee",
      teamCategory: null,
      status: "sent",
    },
  })),
}));

vi.mock("./lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: gate.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signOut: gate.signOut,
    },
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === "profiles" ? gate.profile : null,
          error: null,
        }),
      };
      return query;
    },
  },
}));

vi.mock("./lib/callRuntime", () => ({
  callRuntime: runtime.callRuntime,
}));

vi.mock("./components/AppShell", async () => {
  const { Outlet } = await import("react-router-dom");
  return { AppShell: Outlet };
});

vi.mock("./pages/Page", () => ({ Page: () => null }));

import App from "./App";

function adminProfile() {
  return {
    id: "admin-1",
    role: "admin",
    full_name: "Admin",
    email: "admin@example.com",
    employee_category: null,
  };
}

function visit(path: string) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  gate.session = null;
  gate.profile = null;
  gate.signOut.mockClear();
  runtime.callRuntime.mockClear();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("/invite/accept", () => {
  it("renders the invitation page for a signed-out visitor and keeps the request and auth hash", async () => {
    visit(`${INVITE_PATH}${AUTH_HASH}`);

    expect(await screen.findByRole("heading", { name: "AA Console invitation" })).toBeInTheDocument();
    expect(await screen.findByText("Open the invitation email link to sign in to the invited Auth account.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in to AA Console" })).not.toBeInTheDocument();
    expect(runtime.callRuntime).not.toHaveBeenCalled();
    expect(gate.signOut).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/invite/accept");
    expect(window.location.search).toBe(`?request=${REQUEST}`);
    expect(window.location.hash).toBe(AUTH_HASH);
  });

  it("renders the invitation page for a signed-in visitor with no profile", async () => {
    gate.session = { user: { id: "invitee-1" } };
    visit(`${INVITE_PATH}${AUTH_HASH}`);

    expect(await screen.findByRole("heading", { name: "AA Console invitation" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Accept invitation and create my console access" })).toBeInTheDocument();
    expect(screen.getByText("invitee@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in to AA Console" })).not.toBeInTheDocument();
    await waitFor(() => expect(runtime.callRuntime).toHaveBeenCalledWith(
      "/admin/invitations/inspect",
      { requestId: REQUEST },
    ));
    expect(gate.signOut).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/invite/accept");
    expect(window.location.search).toBe(`?request=${REQUEST}`);
    expect(window.location.hash).toBe(AUTH_HASH);
  });

  it.each(["/not-a-page", "/invite/accepted"])("sends %s through the admin catch-all", async (path) => {
    gate.session = { user: { id: "admin-1" } };
    gate.profile = adminProfile();
    visit(`${path}?request=${REQUEST}${AUTH_HASH}`);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByRole("heading", { name: "AA Console invitation" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(gate.signOut).not.toHaveBeenCalled();
  });

  it("still sends a signed-out unknown path to login", async () => {
    visit(`/not-a-page?request=${REQUEST}${AUTH_HASH}`);

    expect(await screen.findByRole("heading", { name: "Sign in to AA Console" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AA Console invitation" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    expect(gate.signOut).not.toHaveBeenCalled();
  });

  it("still sends a signed-in profile-less visitor on an unknown path to login", async () => {
    gate.session = { user: { id: "invitee-1" } };
    visit(`/not-a-page?request=${REQUEST}${AUTH_HASH}`);

    expect(await screen.findByRole("heading", { name: "Sign in to AA Console" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AA Console invitation" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    expect(gate.signOut).not.toHaveBeenCalled();
  });
});
