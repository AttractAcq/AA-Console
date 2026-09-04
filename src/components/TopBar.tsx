import { LogOut, Menu } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { findAgencyNode, findClientChild } from "../config/navigation";
import { getMemberSections, teamCategoryLabels } from "../data/team";
import type { TeamCategory } from "../data/team";
import { agentSections } from "../data/agents";
import { useRouteEntities } from "../lib/routeEntities";
import { useAuth } from "../context/auth";

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { scope, client, member, agent } = useRouteEntities();
  const { clientId, category } = scope;
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut } = useAuth();

  const breadcrumb = client
    ? buildClientBreadcrumb(client.name, clientId!, location.pathname)
    : category && member
      ? buildMemberBreadcrumb(category, member.name, location.pathname)
      : agent
        ? buildAgentBreadcrumb(agent.name, location.pathname)
        : buildAgencyBreadcrumb(location.pathname);

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        className="flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-[900px]:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {breadcrumb}
      </nav>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          navigate("/login", { replace: true });
        }}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Log out</span>
      </button>
    </header>
  );
}

function buildAgencyBreadcrumb(pathname: string): string {
  const node = findAgencyNode(pathname);
  return node?.label ?? "AA Console";
}

function buildClientBreadcrumb(
  clientName: string,
  clientId: string,
  pathname: string,
): string {
  const rest = pathname.split(`/clients/${clientId}/`)[1] ?? "";
  const [groupPath, childPath] = rest.split("/");
  const match = groupPath && childPath ? findClientChild(groupPath, childPath) : undefined;
  const section = match?.child.label ?? "";
  return section ? `Clients / ${clientName} / ${section}` : `Clients / ${clientName}`;
}

function buildMemberBreadcrumb(
  category: TeamCategory,
  memberName: string,
  pathname: string,
): string {
  const sectionId = pathname.split("/").pop();
  const section = getMemberSections(category).find((s) => s.id === sectionId);
  const categoryLabel = teamCategoryLabels[category].label;
  return section
    ? `Team / ${categoryLabel} / ${memberName} / ${section.label}`
    : `Team / ${categoryLabel} / ${memberName}`;
}

function buildAgentBreadcrumb(agentName: string, pathname: string): string {
  const sectionId = pathname.split("/").pop();
  const section = agentSections.find((s) => s.id === sectionId);
  return section
    ? `Team / Agents / ${agentName} / ${section.label}`
    : `Team / Agents / ${agentName}`;
}
