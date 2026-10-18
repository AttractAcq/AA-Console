import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ArrowLeft, ChevronDown, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { agencyNav, clientNavGroups } from "../config/navigation";
import { getMemberSections, teamCategoryLabels } from "../data/team";
import type { TeamCategory } from "../data/team";
import { agentSections } from "../data/agents";
import { useRouteEntities } from "../lib/routeEntities";
import type { RouteAgent, RouteMember } from "../lib/routeEntities";
import { useTheme } from "../context/theme";
import { cn } from "../lib/cn";

const navItemBase =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";
const navItemInactive = "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground";
const navItemActive = "bg-accent font-medium text-brand-strong";

export function Sidebar({ onNavigate, minimized = false, onToggleMinimized }: {
  onNavigate?: () => void; minimized?: boolean; onToggleMinimized?: () => void;
}) {
  const { scope, client, member, agent } = useRouteEntities();
  const { category } = scope;

  return (
    <aside className={cn("flex h-full flex-col border-r border-sidebar-border bg-sidebar", minimized ? "w-14" : "w-[240px]")}>
      {onToggleMinimized && <button type="button" onClick={onToggleMinimized}
        aria-label={minimized ? "Expand sidebar" : "Minimize sidebar"}
        title={minimized ? "Expand sidebar" : "Minimize sidebar"}
        className={cn(navItemBase, navItemInactive, "mx-2 mt-2 justify-center")}>
        {minimized ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /><span>Minimize sidebar</span></>}
      </button>}
      {!minimized && <>
      {client ? (
        <ClientSidebarContent
          clientId={client.id}
          clientName={client.name}
          clientDetail={client.sector ?? ""}
          onNavigate={onNavigate}
        />
      ) : category && member ? (
        <MemberSidebarContent category={category} member={member} onNavigate={onNavigate} />
      ) : agent ? (
        <AgentSidebarContent agent={agent} onNavigate={onNavigate} />
      ) : (
        <AgencySidebarContent onNavigate={onNavigate} />
      )}
      <ThemeToggle />
      </>}
    </aside>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
        AA
      </div>
      <span className="text-sm font-semibold text-sidebar-foreground">AA Console</span>
    </div>
  );
}

function AgencySidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <Logo />
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {agencyNav.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === "/"}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(navItemBase, isActive ? navItemActive : navItemInactive)
              }
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}

function ClientSidebarContent({
  clientId,
  clientName,
  clientDetail,
  onNavigate,
}: {
  clientId: string;
  clientName: string;
  clientDetail: string;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    delivery: true,
    account: false,
  });
  const [expandedModule, setExpandedModule] = useState<Record<string, boolean>>({});

  return (
    <>
      <div className="px-3 py-4">
        <NavLink
          to="/clients"
          onClick={onNavigate}
          className={cn(navItemBase, navItemInactive, "mb-3")}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          Back to Clients
        </NavLink>
        <div className="px-2.5">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            {clientName}
          </p>
          <p className="truncate text-xs text-muted-foreground">{clientDetail}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {clientNavGroups.map((group) => {
          const isExpanded = expanded[group.id] ?? false;
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [group.id]: !isExpanded }))
                }
                aria-expanded={isExpanded}
                className={cn(
                  navItemBase,
                  navItemInactive,
                  "w-full justify-between font-medium",
                )}
              >
                {group.label}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 transition-transform",
                    isExpanded && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>
              {isExpanded && (
                <div className="mt-0.5 space-y-0.5 pl-2">
                  {group.children?.map((child) => {
                    const Icon = child.icon;
                    const path = `/clients/${clientId}/${group.path}/${child.path}`;
                    if (child.sidebarViews) {
                      const isCurrent = location.pathname === path || location.pathname.startsWith(`${path}/`);
                      const isOpen = expandedModule[child.id] ?? isCurrent;
                      const selectedView = new URLSearchParams(location.search).get("view") ?? child.sidebarViews[0].id;
                      return <div key={child.id}>
                        <button type="button" aria-expanded={isOpen}
                          onClick={() => setExpandedModule((current) => ({ ...current, [child.id]: !isOpen }))}
                          className={cn(navItemBase, "w-full justify-between", isCurrent ? navItemActive : navItemInactive)}>
                          <span className="flex min-w-0 items-center gap-2.5">
                            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                            <span className="text-left">{child.label}</span>
                          </span>
                          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
                        </button>
                        {isOpen && <div className="ml-7 space-y-0.5 border-l border-sidebar-border pl-2">
                          {child.sidebarViews.map((view) => {
                            const target = view.id === child.sidebarViews![0].id ? path : `${path}?view=${view.id}`;
                            const selected = isCurrent && selectedView === view.id;
                            return <Link key={view.id} to={target} onClick={onNavigate}
                              aria-current={selected ? "page" : undefined}
                              className={cn(navItemBase, "text-xs", selected ? navItemActive : navItemInactive)}>
                              {view.label}
                            </Link>;
                          })}
                        </div>}
                      </div>;
                    }
                    return (
                      <NavLink
                        key={child.id}
                        to={path}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(navItemBase, isActive ? navItemActive : navItemInactive)
                        }
                      >
                        {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        {child.label}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </>
  );
}

function MemberSidebarContent({
  category,
  member,
  onNavigate,
}: {
  category: TeamCategory;
  member: RouteMember;
  onNavigate?: () => void;
}) {
  const categoryLabel = teamCategoryLabels[category].label;

  return (
    <>
      <div className="px-3 py-4">
        <NavLink
          to={`/team?tab=${category}`}
          onClick={onNavigate}
          className={cn(navItemBase, navItemInactive, "mb-3")}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          Back to {categoryLabel}
        </NavLink>
        <div className="px-2.5">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            {member.name}
          </p>
          <p className="truncate text-xs capitalize text-muted-foreground">{member.engagement}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {getMemberSections(category).map((section) => (
          <NavLink
            key={section.id}
            to={`/team/${category}/${member.id}/${section.id}`}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(navItemBase, isActive ? navItemActive : navItemInactive)
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function AgentSidebarContent({
  agent,
  onNavigate,
}: {
  agent: RouteAgent;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="px-3 py-4">
        <NavLink
          to="/team?tab=agents"
          onClick={onNavigate}
          className={cn(navItemBase, navItemInactive, "mb-3")}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          Back to Agents
        </NavLink>
        <div className="px-2.5">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            {agent.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">{agent.paused ? "Idle" : "Active"}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {agentSections.map((section) => (
          <NavLink
            key={section.id}
            to={`/team/agents/${agent.agent_key}/${section.id}`}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(navItemBase, isActive ? navItemActive : navItemInactive)
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function ThemeToggle() {
  const { dark, toggleDark } = useTheme();
  return (
    <div className="border-t border-sidebar-border p-3">
      <button
        type="button"
        onClick={toggleDark}
        className={cn(navItemBase, navItemInactive, "w-full")}
        aria-pressed={dark}
      >
        {dark ? (
          <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {dark ? "Light mode" : "Dark mode"}
      </button>
    </div>
  );
}
