import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/auth", () => ({ useAuth }));
vi.mock("../../components/ConsoleShell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../approvals/UnifiedApprovalInboxPanel", () => ({
  UnifiedApprovalInboxPanel: ({ scope }: { scope: string }) =>
    <p data-testid="approval-inbox">{scope}</p>,
}));
vi.mock("./sections/ProductionWorkspace", () => ({
  ProductionWorkspace: () => <p>Editor dashboard</p>,
}));

import { RequireRole } from "../../components/RequireRole";
import { EmployeeConsolePage } from "./EmployeeConsolePage";
import { CONSOLE_NAV } from "../../config/consoleNav";

const person = {
  id: "employee-1", role: "employee", employee_category: "smm",
  member_id: "member-1", client_id: null, full_name: "Manager", email: "manager@example.com",
};

function show() {
  return render(<MemoryRouter initialEntries={["/employee/approvals"]}><Routes>
    <Route path="/employee/:page" element={<RequireRole role="employee">
      <EmployeeConsolePage />
    </RequireRole>} />
    <Route path="/client" element={<p>Client home</p>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  useAuth.mockReturnValue({ loading: false, session: { user: { id: person.id } }, profile: person });
});

describe("manager Approval Inbox route", () => {
  it("opens the multi-client scoped Inbox from the SMM employee console", () => {
    show();
    expect(screen.getByTestId("approval-inbox")).toHaveTextContent("manager");
    expect(CONSOLE_NAV.smm.some((page) => page.id === "approvals")).toBe(true);
    expect(CONSOLE_NAV.editors.some((page) => page.id === "approvals")).toBe(false);
  });

  it("keeps non-manager employees on their own console and denies clients", () => {
    useAuth.mockReturnValue({ loading: false, session: { user: { id: person.id } },
      profile: { ...person, employee_category: "editors" } });
    show();
    expect(screen.queryByTestId("approval-inbox")).not.toBeInTheDocument();
    expect(screen.getByText("Editor dashboard")).toBeInTheDocument();
  });

  it("redirects a client away from the employee approval route", () => {
    useAuth.mockReturnValue({ loading: false, session: { user: { id: person.id } },
      profile: { ...person, role: "client", employee_category: null, member_id: null } });
    show();
    expect(screen.queryByTestId("approval-inbox")).not.toBeInTheDocument();
    expect(screen.getByText("Client home")).toBeInTheDocument();
  });
});
