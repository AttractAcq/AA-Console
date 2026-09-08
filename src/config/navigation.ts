import {
  Contact,
  Palette,
  LayoutDashboard,
  Users,
  Settings2,
  UsersRound,
  ShieldCheck,
  Brain,
  Target,
  FolderCheck,
  Lightbulb,
  Image,
  CheckSquare,
  Share2,
  TrendingUp,
  UserPlus,
  MessagesSquare,
  BarChart3,
  ClipboardList,
  Plug,
  FileText,
  CreditCard,
  History,
  type LucideIcon,
} from "lucide-react";

export type NavTab = { id: string; label: string };

export type NavNode = {
  id: string;
  label: string;
  path: string;
  icon?: LucideIcon;
  description?: string;
  tabs?: NavTab[];
  children?: NavNode[];
};

/** Flat, top-level agency sidebar items. Each may carry its own in-page tabs. */
export const agencyNav: NavNode[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    path: "/",
    icon: LayoutDashboard,
  },
  {
    id: "clients",
    label: "Clients",
    path: "/clients",
    icon: Users,
  },
  {
    id: "operations",
    label: "Operations",
    path: "/operations",
    icon: Settings2,
    tabs: [
      { id: "calendar", label: "Calendar" },
      { id: "campaigns", label: "Campaigns" },
    ],
  },
  {
    id: "team",
    label: "Team",
    path: "/team",
    icon: UsersRound,
    tabs: [
      { id: "chat", label: "Chat" },
      { id: "agents", label: "Agents" },
      { id: "avatars", label: "Avatars" },
      { id: "editors", label: "Editors" },
      { id: "smm", label: "SMM" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    path: "/admin",
    icon: ShieldCheck,
    tabs: [
      { id: "financials", label: "Financials" },
      { id: "sops", label: "SOPs" },
    ],
  },
];

/**
 * Client-mode sidebar: two collapsible groups. Group `path` combines with each
 * child's `path` to form the route segment under `/clients/:clientId/`.
 */
export const clientNavGroups: NavNode[] = [
  {
    id: "delivery",
    label: "Delivery",
    path: "delivery",
    children: [
      {
        id: "delivery-dashboard",
        label: "Dashboard",
        path: "dashboard",
        icon: LayoutDashboard,
      },
      {
        id: "intelligence",
        label: "Intelligence",
        path: "intelligence",
        icon: Brain,
        tabs: [
          { id: "business-context", label: "Business Context" },
          { id: "market", label: "Market" },
          { id: "icp", label: "ICP" },
          { id: "competitors", label: "Competitors" },
          { id: "branding-associations", label: "Branding & Associations" },
          { id: "campaign-intelligence", label: "Campaign Intelligence" },
          { id: "proof-intelligence", label: "Proof Intelligence" },
        ],
      },
      {
        id: "strategy",
        label: "Strategy",
        path: "strategy",
        icon: Target,
        tabs: [
          { id: "branding-strategy", label: "Branding Strategy" },
          { id: "offer-strategy", label: "Offer Strategy" },
          { id: "money-model-strategy", label: "Money Model Strategy" },
        ],
      },
      {
        id: "proof-bank",
        label: "Proof Bank",
        path: "proof-bank",
        icon: FolderCheck,
      },
      {
        id: "ideation",
        label: "Ideation",
        path: "ideation",
        icon: Lightbulb,
        tabs: [
          { id: "generation", label: "Generation" },
          { id: "briefs", label: "Briefs" },
        ],
      },
      {
        id: "media",
        label: "Media",
        path: "media",
        icon: Image,
        tabs: [
          { id: "image-library", label: "Image Library" },
          { id: "video-library", label: "Video Library" },
          { id: "copy-library", label: "Copy Library" },
        ],
      },
      {
        id: "approvals",
        label: "Approvals",
        path: "approvals",
        icon: CheckSquare,
      },
      {
        id: "distribution",
        label: "Distribution",
        path: "distribution",
        icon: Share2,
        tabs: [
          { id: "organic", label: "Organic" },
          { id: "paid", label: "Paid" },
        ],
      },
      {
        id: "conversion",
        label: "Conversion",
        path: "conversion",
        icon: TrendingUp,
        tabs: [
          { id: "primary-landing-pages", label: "Primary Landing Pages" },
          { id: "secondary-offer-pages", label: "Secondary Offer Pages" },
        ],
      },
      {
        id: "sales",
        label: "Sales",
        path: "sales",
        icon: MessagesSquare,
        tabs: [{ id: "overview", label: "Overview" }],
      },
      {
        id: "prospects-leads",
        label: "Prospects & Leads",
        path: "prospects-leads",
        icon: UserPlus,
      },
      {
        id: "reporting",
        label: "Reporting",
        path: "reporting",
        icon: BarChart3,
        tabs: [
          { id: "organic", label: "Organic" },
          { id: "paid", label: "Paid" },
          { id: "landing-pages", label: "Landing Pages" },
          { id: "offer-pages", label: "Offer Pages" },
          { id: "attribution", label: "Attribution" },
          { id: "commentary", label: "Commentary" },
        ],
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    path: "account",
    children: [
      {
        id: "onboarding",
        label: "Onboarding",
        path: "onboarding",
        icon: ClipboardList,
      },
      {
        id: "contact",
        label: "Contact & Identity",
        path: "contact",
        icon: Contact,
      },
      {
        id: "brand",
        label: "Brand & Design",
        path: "brand",
        icon: Palette,
      },
      {
        id: "integrations",
        label: "Integrations & Credentials",
        path: "integrations",
        icon: Plug,
      },
      {
        id: "contracts",
        label: "Contracts & Legal",
        path: "contracts",
        icon: FileText,
      },
      {
        id: "billing",
        label: "Billing & Subscription",
        path: "billing",
        icon: CreditCard,
      },
      {
        id: "audit-log",
        label: "Audit Log",
        path: "audit-log",
        icon: History,
      },
    ],
  },
];

export function findAgencyNode(pathname: string): NavNode | undefined {
  return agencyNav.find((node) => node.path === pathname);
}

export function findClientChild(
  groupPath: string,
  childPath: string,
): { group: NavNode; child: NavNode } | undefined {
  const group = clientNavGroups.find((g) => g.path === groupPath);
  const child = group?.children?.find((c) => c.path === childPath);
  if (!group || !child) return undefined;
  return { group, child };
}
