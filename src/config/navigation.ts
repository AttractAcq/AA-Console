import {
  Archive,
  BarChart3,
  Brain,
  CheckSquare,
  ClipboardList,
  Coins,
  Contact,
  CreditCard,
  FileText,
  Clapperboard,
  FolderCheck,
  Globe,
  History,
  Image,
  LayoutDashboard,
  Lightbulb,
  Megaphone,
  MessagesSquare,
  Palette,
  Plug,
  Settings2,
  Scissors,
  Share2,
  ShieldCheck,
  Compass,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type NavTab = { id: string; label: string };

export type NavNode = {
  id: string;
  label: string;
  path: string;
  icon?: LucideIcon;
  description?: string;
  capability?: "available" | "expanding" | "planned";
  tabs?: NavTab[];
  children?: NavNode[];
  sidebarViews?: { id: string; label: string }[];
};

const versionViews = [{ id: "v1", label: "v1" }, { id: "v2", label: "v2" }];

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
      { id: "creative_director", label: "Creative Directors" },
      // Hiring sits after the people already here: the ads, then the pages
      // those ads point at.
      { id: "recruitment", label: "Recruitment" },
      { id: "recruitment-pages", label: "Recruitment Landing Pages" },
      { id: "recruitment-distribution", label: "Recruitment Distribution" },
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
const legacyClientNavGroups: NavNode[] = [
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
          { id: "content-pillars", label: "Content Pillars" },
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
        id: "create",
        label: "Create",
        path: "create",
        icon: Clapperboard,
      },
      {
        id: "edit-repurpose",
        label: "Edit / Repurpose",
        path: "edit-repurpose",
        icon: Scissors,
        tabs: [{ id: "overview", label: "Video edits" }],
      },
      {
        id: "approvals",
        label: "Approvals",
        path: "approvals",
        icon: CheckSquare,
        // Two queues, because they are two different acts. Assets signs an
        // asset off; Engine is the one human commit the engine stops at,
        // which also puts the post on the calendar. Approving engine work
        // on the Assets tab would approve the asset and leave the slot
        // where it was.
        tabs: [
          { id: "engine-inbox", label: "Engine" },
          { id: "assets", label: "Assets" },
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
          { id: "reel-shots", label: "Reel shots" },
          { id: "copy-library", label: "Copy Library" },
          { id: "story-library", label: "Story Library" },
          { id: "carousel-library", label: "Carousel Library" },
        ],
      },
      {
        id: "distribution",
        label: "Distribution",
        path: "distribution",
        icon: Share2,
        tabs: [
          { id: "distribution-assets", label: "Assets" },
          { id: "organic", label: "Organic" },
          { id: "paid", label: "Paid" },
          { id: "engine", label: "Engine" },
        ],
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
      {
        id: "campaign-execution",
        label: "Campaigns",
        path: "campaign-execution",
        icon: Megaphone,
        tabs: [{ id: "overview", label: "Overview" }],
      },
      {
        // The page-building half of Sites. Kept as its own route so nothing
        // bookmarked breaks, but labelled so it no longer reads as a second,
        // competing website system.
        id: "conversion",
        label: "Page Builder",
        path: "conversion",
        icon: TrendingUp,
        tabs: [
          { id: "primary-landing-pages", label: "Primary Landing Pages" },
          { id: "secondary-offer-pages", label: "Secondary Offer Pages" },
        ],
      },
      {
        id: "motion-design",
        label: "Motion Design",
        path: "motion-design",
        icon: Clapperboard,
      },
      {
        id: "sales",
        label: "Sales Agents",
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
        id: "economics",
        label: "Economics",
        path: "economics",
        icon: Coins,
        tabs: [{ id: "overview", label: "Overview" }],
      },
      {
        // Last in Delivery, because it is where work goes when it is no
        // longer work. The other three domains get their own tabs here as
        // they are brought over.
        id: "archive",
        label: "Archive",
        path: "archive",
        icon: Archive,
        tabs: [
          { id: "content-production", label: "Content Production" },
          { id: "pages", label: "Pages" },
          { id: "campaigns", label: "Campaigns" },
          { id: "sales-agents", label: "Sales Agents" },
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
        // Where this client's site lives and which GitHub account publishes
        // it. Account-level configuration, not a step in delivery.
        id: "sites",
        label: "Sites",
        path: "sites",
        icon: Globe,
        tabs: [
          { id: "overview", label: "Overview" },
          { id: "settings", label: "Settings" },
        ],
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

/** Historical Delivery URLs remain routable while each v5 view gets a v6 home. */
export const legacyDeliveryNodes = (legacyClientNavGroups[0]?.children ?? []).filter(
  (node) => !["dashboard", "motion-design", "archive"].includes(node.path),
);

/** Every acquisition component is a distinct Delivery page, in product order. */
export const v6ModuleNodes: NavNode[] = [
  { id: "intelligence-os", label: "Intelligence OS", path: "intelligence-os", icon: Brain, capability: "expanding",
    sidebarViews: [{ id: "intelligence", label: "Intelligence" }, { id: "strategy", label: "Strategy" }],
    tabs: [
      { id: "business-context", label: "Business Context" }, { id: "market", label: "Market" },
      { id: "icp", label: "ICP" }, { id: "competitors", label: "Competitors" },
      { id: "branding-associations", label: "Branding & Associations" },
      { id: "campaign-intelligence", label: "Campaign Intelligence" },
      { id: "campaign-inputs", label: "Campaign Inputs" },
      { id: "proof-intelligence", label: "Proof Intelligence" },
      { id: "branding-strategy", label: "Branding Strategy" },
      { id: "content-pillars", label: "Content Pillars" },
      { id: "money-model-strategy", label: "Money Model Strategy" },
    ] },
  // Between intelligence and campaigns on purpose: an opportunity is the
  // commercial reason a campaign should exist, and reading those two in the
  // other order is how a business ends up with attractive campaigns that are
  // not rooted in anything somebody would actually buy.
  { id: "market-opportunities", label: "Market Opportunities", path: "market-opportunities",
    icon: Compass, capability: "expanding", tabs: [
      { id: "discover", label: "Discover" }, { id: "evaluate", label: "Evaluate" },
      { id: "strategize", label: "Strategize" }, { id: "activate", label: "Activate" },
    ] },
  { id: "campaign-factory", label: "Campaign Factory", path: "campaign-factory", icon: Megaphone, sidebarViews: versionViews,
    capability: "expanding", tabs: [{ id: "overview", label: "Campaigns" }] },
  { id: "proof-production-factory", label: "Proof Production Factory", path: "proof-production-factory",
    icon: FolderCheck, capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "proof-bank", label: "Proof Bank" },
      { id: "artifacts", label: "Proof Artifacts" },
    ] },
  { id: "content-production-factory", label: "Content Production Factory", path: "content-production-factory",
    icon: Clapperboard, capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "generation", label: "Ideation" }, { id: "briefs", label: "Briefs" },
      { id: "create", label: "Create" }, { id: "edit", label: "Edit / Repurpose" },
      { id: "image-library", label: "Images" }, { id: "video-library", label: "Videos" },
      { id: "reel-shots", label: "Reel Shots" }, { id: "copy-library", label: "Copy" },
      { id: "story-library", label: "Stories" }, { id: "carousel-library", label: "Carousels" },
    ] },
  { id: "proof-distribution", label: "Proof Distribution", path: "proof-distribution", icon: Share2,
    capability: "expanding", tabs: [
      { id: "destinations", label: "Destinations" },
      { id: "placements", label: "Placements" },
      { id: "rights", label: "Rights" },
    ] },
  { id: "content-distribution", label: "Organic Content Distribution", path: "content-distribution", icon: Share2,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "distribution-assets", label: "Assets" }, { id: "organic", label: "Organic" },
      { id: "engine", label: "Engine" },
    ] },
  { id: "google-ads-studio", label: "Google Ads Studio", path: "google-ads-studio", icon: Megaphone,
    capability: "expanding", tabs: [
      { id: "sheet", label: "Build sheet" }, { id: "account", label: "Account" },
      { id: "build", label: "Automated build" },
    ] },
  { id: "meta-ads-studio", label: "Meta Ads Studio", path: "meta-ads-studio", icon: Megaphone,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "campaigns", label: "Campaign Builds" }, { id: "paid", label: "Paid Distribution" },
      { id: "reporting", label: "Paid Reporting" },
    ] },
  { id: "google-profile", label: "Google Profile", path: "google-profile", icon: Globe,
    capability: "expanding", tabs: [
      { id: "location", label: "Location" }, { id: "reviews", label: "Reviews" },
      { id: "posts", label: "Posts" }, { id: "metrics", label: "Metrics" },
    ] },
  { id: "meta-profile", label: "Meta Profile", path: "meta-profile", icon: Users,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "organic", label: "Posts" }, { id: "reporting", label: "Profile Metrics" },
    ] },
  { id: "offer-studio", label: "Offer Studio", path: "offer-studio", icon: Target,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "offers", label: "Service Offers" },
      { id: "offer-strategy", label: "Offer Strategy" },
    ] },
  { id: "website-studio", label: "Website Studio", path: "website-studio", icon: Globe,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "landing-pages", label: "Landing Pages" }, { id: "offer-pages", label: "Offer Pages" },
      { id: "sites", label: "Sites" }, { id: "landing-reporting", label: "Landing Results" },
      { id: "offer-reporting", label: "Offer Results" },
    ] },
  { id: "lead-magnet-studio", label: "Lead Magnet Studio", path: "lead-magnet-studio", icon: UserPlus,
    capability: "expanding", tabs: [
      { id: "magnets", label: "Magnets" }, { id: "build", label: "Build" },
      { id: "delivery", label: "Delivery" }, { id: "optins", label: "Opt-ins" },
    ] },
  { id: "sales-os", label: "Sales OS", path: "sales-os", icon: MessagesSquare,
    capability: "expanding", sidebarViews: versionViews, tabs: [
      { id: "leads", label: "Prospects & Leads" }, { id: "agents", label: "Sales Agents" },
    ] },
  { id: "attribution-os", label: "Attribution OS", path: "attribution-os", icon: BarChart3,
    capability: "expanding", tabs: [
      { id: "overview", label: "Attribution" }, { id: "organic", label: "Organic" },
      { id: "paid", label: "Paid" }, { id: "landing-pages", label: "Landing Pages" },
      { id: "offer-pages", label: "Offer Pages" }, { id: "commentary", label: "Commentary" },
      { id: "economics", label: "Economics" },
    ] },
];

const legacyUtility = (path: string) => legacyClientNavGroups[0]!.children!.find((node) => node.path === path)!;

export const clientNavGroups: NavNode[] = [
  { id: "delivery", label: "Delivery", path: "delivery", children: [
    legacyUtility("dashboard"),
    { id: "approval-inbox", label: "Approval Inbox", path: "approval-inbox", icon: CheckSquare,
      capability: "expanding", tabs: [
        { id: "engine-inbox", label: "Engine" }, { id: "assets", label: "Assets" },
        { id: "campaign-actions", label: "Campaign actions" },
      ] },
    ...v6ModuleNodes,
    { ...legacyUtility("motion-design"), sidebarViews: versionViews },
    legacyUtility("archive"),
  ] },
  ...legacyClientNavGroups.slice(1),
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
