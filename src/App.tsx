import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RequireRole } from "./components/RequireRole";
import { Page } from "./pages/Page";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { ClientLoginPage } from "./pages/client/ClientLoginPage";
import { ClientConsolePage } from "./pages/client/ClientConsolePage";
import { EmployeeLoginPage } from "./pages/employee/EmployeeLoginPage";
import { EmployeeConsolePage } from "./pages/employee/EmployeeConsolePage";
import { MemberDetailPage } from "./pages/operations/MemberDetailPage";
import { AgentDetailPage } from "./pages/team/AgentDetailPage";
import { ThemeProvider } from "./context/theme";
import { AuthProvider } from "./context/auth";
import { agencyNav, clientNavGroups } from "./config/navigation";
import { memberSections } from "./data/team";
import { agentSections } from "./data/agents";

const dashboardNode = agencyNav.find((n) => n.id === "dashboard")!;
const operationsNode = agencyNav.find((n) => n.id === "operations")!;
const teamNode = agencyNav.find((n) => n.id === "team")!;
const adminNode = agencyNav.find((n) => n.id === "admin")!;

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route path="/client/login" element={<ClientLoginPage />} />
            <Route
              path="/client"
              element={<Navigate to="/client/dashboard" replace />}
            />
            <Route
              path="/client/:page"
              element={
                <RequireRole role="client">
                  <ClientConsolePage />
                </RequireRole>
              }
            />

            <Route path="/employee/login" element={<EmployeeLoginPage />} />
            <Route
              path="/employee"
              element={<Navigate to="/employee/dashboard" replace />}
            />
            <Route
              path="/employee/:page"
              element={
                <RequireRole role="employee">
                  <EmployeeConsolePage />
                </RequireRole>
              }
            />

            <Route
              path="/"
              element={
                <RequireRole role="admin">
                  <AppShell />
                </RequireRole>
              }
            >
              <Route index element={<Page node={dashboardNode} />} />
              <Route path="clients" element={<ClientsPage />} />
              <Route path="admin" element={<Page node={adminNode} />} />

              <Route path="operations" element={<Page node={operationsNode} />} />

              <Route path="team">
                <Route index element={<Page node={teamNode} />} />
                <Route path=":category/:memberId">
                  <Route index element={<Navigate to="overview" replace />} />
                  {memberSections.map((section) => (
                    <Route
                      key={section.id}
                      path={section.id}
                      element={<MemberDetailPage sectionId={section.id} />}
                    />
                  ))}
                </Route>
                <Route path="agents/:agentId">
                  <Route index element={<Navigate to="overview" replace />} />
                  {agentSections.map((section) => (
                    <Route
                      key={section.id}
                      path={section.id}
                      element={<AgentDetailPage sectionId={section.id} />}
                    />
                  ))}
                </Route>
              </Route>

              <Route path="clients/:clientId">
                <Route
                  index
                  element={<Navigate to="delivery/dashboard" replace />}
                />
                {clientNavGroups.flatMap((group) =>
                  (group.children ?? []).map((child) => (
                    <Route
                      key={`${group.id}-${child.id}`}
                      path={`${group.path}/${child.path}`}
                      element={<Page node={child} />}
                    />
                  )),
                )}
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
