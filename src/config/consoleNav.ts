import {
  LayoutDashboard,
  MessagesSquare,
  Megaphone,
  Share2,
  TrendingUp,
  UserCog,
  FolderOpen,
  FolderCheck,
  Users,
  UsersRound,
  ClipboardList,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import type { EmployeeCategory } from "../lib/identity";

export type ConsolePage = { id: string; label: string; icon: LucideIcon };

/** Which console a signed-in user sees is decided by role, then category. */
export type ConsoleKind = "client" | "avatars" | "editors" | "smm";

export const CONSOLE_NAV: Record<ConsoleKind, ConsolePage[]> = {
  client: [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "active-campaigns", label: "Active Campaigns", icon: Megaphone },
    { id: "active-organic", label: "Active Organic", icon: Share2 },
    { id: "active-conversion", label: "Active Conversion", icon: TrendingUp },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "account", label: "Account", icon: UserCog },
  ],
  editors: [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "current-projects", label: "Current Projects", icon: FolderOpen },
    { id: "past-projects", label: "Past Projects", icon: FolderCheck },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "account", label: "Account", icon: UserCog },
  ],
  smm: [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "current-clients", label: "Current Clients", icon: Users },
    { id: "past-clients", label: "Past Clients", icon: UsersRound },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "account", label: "Account", icon: UserCog },
  ],
  avatars: [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "current-jobs", label: "Current Jobs", icon: ClipboardList },
    { id: "past-jobs", label: "Past Jobs", icon: ClipboardCheck },
    { id: "chat", label: "Chat", icon: MessagesSquare },
    { id: "account", label: "Account", icon: UserCog },
  ],
};

export function consoleKindFor(
  role: "client" | "employee",
  category: EmployeeCategory | null,
): ConsoleKind | null {
  if (role === "client") return "client";
  return category ?? null;
}

export function findConsolePage(kind: ConsoleKind, pageId: string | undefined): ConsolePage {
  const pages = CONSOLE_NAV[kind];
  return pages.find((p) => p.id === pageId) ?? pages[0];
}
