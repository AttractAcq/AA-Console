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
    id: "agency-approval-inbox",
    label: "Approval Inbox",
    path: "/approvals",
    icon: CheckSquare,
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
      { id: "system-readiness", label: "System readiness" },
      { id: "schema-parity", label: "Schema parity" },
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
        // longer work. Migration 312 brought the remaining domains over, which
        // is what the note here used to anticipate.
        id: "archive",
        label: "Archive",
        path: "archive",
        icon: Archive,
        tabs: [
          { id: "content-production", label: "Content Production" },
          { id: "pages", label: "Pages" },
          { id: "campaigns", label: "Campaigns" },
          { id: "sales-agents", label: "Sales Agents" },
          { id: "opportunities", label: "Opportunities" },
          { id: "models", label: "Models" },
          { id: "lead-magnets", label: "Lead Magnets" },
          // Last, and not an archive stamp: anything turned down in review
          // lands here with its reason, so the what-worked trend is visible.
          { id: "rejected", label: "Rejected Creative" },
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

/**
 * Where each replaced v5 Delivery page sends you now.
 *
 * The pages are archived, not the links to them: these paths were bookmarked,
 * pasted into chat and linked from records for a year. Each one names the v6
 * page that took over its work, with the tab that matches where it landed.
 *
 * A legacy query survives the redirect and wins over the default here, so
 * `media?tab=reel-shots` still opens the reel shots library — Assets keeps
 * v1's tab ids for exactly that reason.
 */
export const legacyDeliveryRedirects: Record<string, string> = {
  intelligence: "intelligence-os",
  strategy: "intelligence-os?view=strategy",
  "proof-bank": "proof-production-factory",
  ideation: "content-production-factory",
  create: "content-production-factory?tab=create",
  "edit-repurpose": "content-production-factory?tab=edit",
  approvals: "approval-inbox",
  media: "content-production-factory?tab=assets",
  distribution: "content-distribution",
  reporting: "attribution-os",
  "campaign-execution": "campaign-factory",
  conversion: "website-studio",
  sales: "sales-os?tab=agents",
  "prospects-leads": "attribution-os?tab=leads",
  economics: "attribution-os?tab=economics",
};

/** Delivery page definitions; clientDeliverySections sets their sidebar order. */
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
      // The notes: "the offer strategy tab needs to be moved back to under the
      // strategy module as its own tab." Moving it also needs Page.tsx's
      // strategyTabIds, or the filter there files it under Intelligence.
      { id: "offer-strategy", label: "Offer Strategy" },
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
  // No tabs on purpose: the page is one table of campaigns.
  { id: "campaign-factory", label: "Campaign Factory", path: "campaign-factory", icon: Megaphone,
    capability: "expanding" },
  { id: "proof-production-factory", label: "Proof Production Factory", path: "proof-production-factory",
    icon: FolderCheck, capability: "expanding", tabs: [
      { id: "capture", label: "Capture" }, { id: "produce", label: "Produce" },
      { id: "repurpose", label: "Repurpose" }, { id: "assets", label: "Assets" },
    ] },
  { id: "content-production-factory", label: "Content Production Factory", path: "content-production-factory",
    icon: Clapperboard, capability: "expanding", tabs: [
      { id: "generation", label: "Ideation" }, { id: "briefs", label: "Briefs" },
      { id: "create", label: "Create" }, { id: "edit", label: "Edit / Repurpose" },
      { id: "assets", label: "Assets" },
    ] },
  { id: "proof-distribution", label: "Proof Distribution", path: "proof-distribution", icon: Share2,
    capability: "expanding", tabs: [
      { id: "destinations", label: "Destinations" },
      // Placements and Rights are archived: see docs/V6_1_ARCHIVED_SURFACES.md.
      // Their panels still build; only the way in is gone, so v6.2 can delete
      // the code without a second decision.
    ] },
  { id: "content-distribution", label: "Organic Content Distribution", path: "content-distribution", icon: Share2,
    capability: "expanding", tabs: [
      { id: "distribution-assets", label: "Assets" },
      { id: "organic", label: "Organic Calendar" },
      { id: "engine", label: "Engine" },
    ] },
  { id: "google-ads-studio", label: "Google Ads Studio", path: "google-ads-studio", icon: Megaphone,
    capability: "expanding", tabs: [
      { id: "sheet", label: "Build sheet" }, { id: "account", label: "Account" },
      { id: "build", label: "Automated build" },
    ] },
  { id: "meta-ads-studio", label: "Meta Ads Studio", path: "meta-ads-studio", icon: Megaphone,
    capability: "expanding", tabs: [
      // Read-only, which is the whole of item 14: "deliberately less than
      // today: the build and management moved to a human paid-ads operator."
      // Build and Campaign Builds are archived -- see
      // docs/V6_1_ARCHIVED_SURFACES.md. An unknown ?tab= falls back to the
      // first tab here, so a bookmarked link still lands somewhere useful.
      { id: "paid", label: "Paid Distribution" }, { id: "reporting", label: "Paid Reporting" },
    ] },
  { id: "google-profile", label: "Google Studio", path: "google-profile", icon: Globe,
    capability: "expanding", tabs: [
      { id: "location", label: "Location" }, { id: "reviews", label: "Reviews" },
      { id: "posts", label: "Posts" }, { id: "metrics", label: "Metrics" },
    ] },
  { id: "meta-profile", label: "Meta Profile", path: "meta-profile", icon: Users,
    capability: "expanding", tabs: [
      { id: "identities", label: "Identities" }, { id: "profile", label: "Profile" },
      { id: "presence", label: "Presence" }, { id: "organic", label: "Posts" },
      { id: "reporting", label: "Outcomes" },
    ] },
  { id: "offer-studio", label: "Offer Studio", path: "offer-studio", icon: Target,
    capability: "expanding", tabs: [
      // One operating page, per the notes: a table of every offer with
      // click-through detail and two create buttons. Live use folded into the
      // rows, where a superseded-but-live version is named on its own offer.
      // Versions keeps the existing version and claims form reachable.
      { id: "offers", label: "Offers" },
      { id: "versions", label: "Versions" },
      // Offer Strategy moved to Intelligence OS, Strategy half.
    ] },
  { id: "website-studio", label: "Website Studio", path: "website-studio", icon: Globe,
    capability: "expanding", tabs: [
      // Sites first: phase 3 item 9 makes this module a Sites table with build
      // buttons, and SitesPanel already carries the table, the publish control
      // and the agent attach.
      { id: "sites", label: "Sites" },
      { id: "landing-pages", label: "Landing Pages" },
      { id: "offer-pages", label: "Offer Pages" },
      // Publish stays its own tab for now. It is NOT the publish button on a
      // site row: it is the board of what happened to each campaign page
      // decision, and it carries a state nothing else does -- "published, and
      // nobody has tested the form yet", which looks identical to working.
      { id: "publish", label: "Publish" },
      // Results is gone. It rendered PagesReportingPanel with pageType
      // "landing" -- byte for byte what Attribution OS -> Landing Pages
      // already renders. Two routes to one component is not a tab, it is a
      // duplicate, and reporting belongs to Attribution OS.
    ] },
  { id: "lead-magnet-studio", label: "Lead Magnet Studio", path: "lead-magnet-studio", icon: UserPlus,
    capability: "expanding", tabs: [
      // One operating page, per phase 3 item 7. Build was this table with a
      // create button on top, so the button moved onto the page. Delivery's
      // switch was already on the Dashboard panel and its approval queue is
      // now in the row detail, next to the bytes it decides. Opt-ins is
      // archived; capture endpoints live in Sales OS -> Capture.
      { id: "magnets", label: "Magnets" },
    ] },
  { id: "sales-os", label: "Sales OS", path: "sales-os", icon: MessagesSquare,
    capability: "expanding", tabs: [
      // Agents first, per phase 3 item 11: "Agents as the main table page".
      // The first tab is the one the module opens on, so the order IS the
      // claim about what this module is for.
      { id: "agents", label: "Agents" },
      // Capture is "left alone for now" in the notes, and it is also the only
      // place capture endpoints are created now that Lead Magnet Studio's
      // Opt-ins is archived.
      { id: "capture", label: "Capture" },
      // Pipeline moved to Attribution OS. It is a record of what happened to
      // the leads, which is an attribution question rather than a sales-agent
      // one.
    ] },
  { id: "attribution-os", label: "Attribution OS", path: "attribution-os", icon: BarChart3,
    capability: "expanding", tabs: [
      { id: "overview", label: "Attribution" }, { id: "organic", label: "Organic" },
      { id: "paid", label: "Paid" }, { id: "landing-pages", label: "Landing Pages" },
      { id: "offer-pages", label: "Offer Pages" },
      // Arrived from Sales OS in phase 3 item 11.
      { id: "leads", label: "Pipeline" },
      { id: "commentary", label: "Commentary" },
      { id: "economics", label: "Economics" },
    ] },
];

const legacyUtility = (path: string) => legacyClientNavGroups[0]!.children!.find((node) => node.path === path)!;
const moduleNode = (id: string) => v6ModuleNodes.find((node) => node.id === id)!;

/** Sidebar presentation order; routes still use the flat clientNavGroups list. */
export const clientDeliverySections: { id: string; label?: string; children: NavNode[] }[] = [
  { id: "entry", children: [
    legacyUtility("dashboard"),
    { id: "approval-inbox", label: "Approval Inbox", path: "approval-inbox", icon: CheckSquare,
      capability: "expanding", tabs: [
        { id: "engine-inbox", label: "Engine" }, { id: "assets", label: "Assets" },
        { id: "campaign-actions", label: "Campaign actions" },
        { id: "unified", label: "Unified" },
      ] },
    moduleNode("intelligence-os"),
  ] },
  { id: "primary", label: "Primary Flow", children: [
    moduleNode("market-opportunities"), moduleNode("offer-studio"),
    moduleNode("campaign-factory"), moduleNode("content-production-factory"),
  ] },
  { id: "meta", label: "Meta", children: [
    moduleNode("content-distribution"), moduleNode("meta-ads-studio"), moduleNode("meta-profile"),
  ] },
  { id: "google", label: "Google", children: [
    moduleNode("google-ads-studio"), moduleNode("google-profile"),
  ] },
  { id: "proof", label: "Proof", children: [
    moduleNode("proof-production-factory"), moduleNode("proof-distribution"),
  ] },
  { id: "secondary", label: "Secondary Flow", children: [
    moduleNode("website-studio"), moduleNode("sales-os"), moduleNode("lead-magnet-studio"),
    { ...legacyUtility("motion-design"), capability: "expanding", tabs: [
      { id: "brief", label: "Brief" }, { id: "scenes", label: "Scenes" },
      { id: "renders", label: "Renders" },
    ] },
  ] },
  { id: "end", children: [moduleNode("attribution-os"), legacyUtility("archive")] },
];

export const clientNavGroups: NavNode[] = [
  { id: "delivery", label: "Delivery", path: "delivery",
    children: clientDeliverySections.flatMap((section) => section.children) },
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
