import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "client" | "employee" }));

vi.mock("./context/auth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ loading: false,
    profile: { id: "test-user", role: auth.role }, session: { user: { id: "test-user" } } }),
}));
vi.mock("./context/theme", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/AppShell", async () => {
  const { Outlet } = await import("react-router-dom");
  return { AppShell: Outlet };
});
vi.mock("./pages/Page", () => ({ Page: () => null }));
vi.mock("./pages/approvals/UnifiedApprovalInboxPanel", () => ({
  UnifiedApprovalInboxPanel: ({ scope }: { scope: string }) =>
    <h1>{scope === "global" ? "Admin global approvals" : "Client approvals"}</h1>,
}));
vi.mock("./pages/employee/EmployeeConsolePage", () => ({
  EmployeeConsolePage: () => <h1>Employee console</h1>,
}));
vi.mock("./pages/client/ClientConsolePage", () => ({
  ClientConsolePage: () => <h1>Client console</h1>,
}));

import App from "./App";

beforeEach(() => {
  auth.role = "admin";
  window.history.replaceState({}, "", "/approvals");
});

describe("agency approval route", () => {
  it("opens the global Inbox inside the admin shell", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Admin global approvals" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/approvals");
  });

  it.each(["client", "employee"] as const)("redirects a %s away from the global Inbox", async (role) => {
    auth.role = role;
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toMatch(new RegExp(`^/${role}/`)));
    expect(screen.queryByRole("heading", { name: "Admin global approvals" })).not.toBeInTheDocument();
  });
});
