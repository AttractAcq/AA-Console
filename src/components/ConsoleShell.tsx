import { useState } from "react";
import { LogOut, Menu } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../context/auth";
import { LOGIN_FOR_ROLE } from "../lib/identity";
import type { ConsoleRole } from "../lib/identity";
import { CONSOLE_NAV } from "../config/consoleNav";
import type { ConsoleKind } from "../config/consoleNav";
import { useTheme } from "../context/theme";
import { cn } from "../lib/cn";

const navItemBase =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const navItemInactive =
  "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground";
const navItemActive = "bg-accent font-medium text-brand-strong";

function ConsoleSidebar({
  kind,
  basePath,
  title,
  subtitle,
  onNavigate,
}: {
  kind: ConsoleKind;
  basePath: string;
  title: string;
  subtitle?: string;
  onNavigate?: () => void;
}) {
  const { dark, toggleDark } = useTheme();

  return (
    <aside className="flex h-full w-[240px] flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          AA
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">{title}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {CONSOLE_NAV[kind].map((page) => {
          const Icon = page.icon;
          return (
            <NavLink
              key={page.id}
              to={`${basePath}/${page.id}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(navItemBase, isActive ? navItemActive : navItemInactive)
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {page.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <button
          type="button"
          onClick={toggleDark}
          className={cn(navItemBase, navItemInactive, "w-full")}
          aria-pressed={dark}
        >
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  );
}

export function ConsoleShell({
  role,
  kind,
  basePath,
  title,
  subtitle,
  heading,
  children,
}: {
  role: ConsoleRole;
  kind: ConsoleKind;
  basePath: string;
  title: string;
  subtitle?: string;
  heading: string;
  children: ReactNode;
}) {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="hidden min-[900px]:block">
        <ConsoleSidebar kind={kind} basePath={basePath} title={title} subtitle={subtitle} />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 min-[900px]:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-[240px]">
            <ConsoleSidebar
              kind={kind}
              basePath={basePath}
              title={title}
              subtitle={subtitle}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-[900px]:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <span className="truncate text-sm text-muted-foreground">{title}</span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {profile?.full_name ?? profile?.email}
            </span>
            <button
              type="button"
              onClick={async () => {
                await signOut();
                navigate(LOGIN_FOR_ROLE[role], { replace: true });
              }}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Log out
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-5xl">
            <h1 className="mb-6 text-xl font-semibold text-foreground">{heading}</h1>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
