import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../context/auth";
import { HOME_FOR_ROLE, LOGIN_FOR_ROLE } from "../lib/identity";
import type { ConsoleRole } from "../lib/identity";

/**
 * Gates a console to one role. A signed-in user who lands on the wrong
 * console is sent to their own rather than to a login screen — they are
 * authenticated, just not here.
 */
export function RequireRole({ role, children }: { role: ConsoleRole; children: ReactNode }) {
  const { profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!profile) {
    return <Navigate to={LOGIN_FOR_ROLE[role]} replace state={{ from: location.pathname }} />;
  }

  if (profile.role !== role) {
    return <Navigate to={HOME_FOR_ROLE[profile.role]} replace />;
  }

  return children;
}
