import { useSearchParams } from "react-router-dom";
import { ClientDashboardPanel } from "./dashboard/ClientDashboardPanel";
import type { ReactNode } from "react";
import type { NavNode, NavTab } from "../config/navigation";
import { PageHeader } from "../components/PageHeader";
import { Tabs } from "../components/Tabs";
import { EmptyState } from "../components/EmptyState";
import { DashboardPanel } from "./DashboardPanel";
import { BusinessContextPanel } from "./intelligence/BusinessContextPanel";
import { IcpPanel } from "./intelligence/IcpPanel";
import { MarketPanel } from "./intelligence/MarketPanel";
import { ProofIntelligencePanel } from "./intelligence/ProofIntelligencePanel";
import { CompetitorsPanel } from "./intelligence/CompetitorsPanel";
import { BrandingAssociationsPanel } from "./intelligence/BrandingAssociationsPanel";
import { CampaignIntelligencePanel } from "./intelligence/CampaignIntelligencePanel";
import { BrandingStrategyPanel } from "./strategy/BrandingStrategyPanel";
import { OfferStrategyPanel } from "./strategy/OfferStrategyPanel";
import { MoneyModelStrategyPanel } from "./strategy/MoneyModelStrategyPanel";
import { ProofBankPanel } from "./proof-bank/ProofBankPanel";
import { GenerationPanel } from "./ideation/GenerationPanel";
import { BriefsPanel } from "./ideation/BriefsPanel";
import { ImageLibraryPanel } from "./media/ImageLibraryPanel";
import { VideoLibraryPanel } from "./media/VideoLibraryPanel";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel";
import { OrganicPanel } from "./distribution/OrganicPanel";
import { PaidPanel } from "./distribution/PaidPanel";
import { PageBuilderPanel } from "./conversion/PageBuilderPanel";
import { SalesAgentsPanel } from "./conversion/SalesAgentsPanel";
import { ProspectsLeadsPanel } from "./prospects-leads/ProspectsLeadsPanel";
import { OnboardingPanel } from "./account/OnboardingPanel";
import { ContactPanel } from "./account/ContactPanel";
import { BrandPanel } from "./account/BrandPanel";
import { IntegrationsPanel } from "./account/IntegrationsPanel";
import { CopyLibraryPanel } from "./media/CopyLibraryPanel";
import { PaidReportingPanel } from "./reporting/PaidReportingPanel";
import { OrganicReportingPanel } from "./reporting/OrganicReportingPanel";
import { PagesReportingPanel } from "./reporting/PagesReportingPanel";
import { AttributionPanel } from "./reporting/AttributionPanel";
import { CommentaryPanel } from "./reporting/CommentaryPanel";
import { ContractsLegalPanel } from "./account/ContractsLegalPanel";
import { BillingSubscriptionPanel } from "./account/BillingSubscriptionPanel";
import { AuditLogPanel } from "./account/AuditLogPanel";
import { TeamCategoryPanel } from "./operations/TeamCategoryPanel";
import { CampaignsPanel } from "./operations/CampaignsPanel";
import { CalendarPanel } from "./operations/CalendarPanel";
import { ChatPanel } from "./team/ChatPanel";
import { AgentsPanel } from "./team/AgentsPanel";
import { FinancialsPanel } from "./admin/FinancialsPanel";
import { SopsPanel } from "./admin/SopsPanel";

const nodeTabPanels: Record<string, Record<string, () => ReactNode>> = {
  admin: {
    financials: () => <FinancialsPanel />,
    sops: () => <SopsPanel />,
  },
  operations: {
    calendar: () => <CalendarPanel />,
    campaigns: () => <CampaignsPanel />,
  },
  team: {
    chat: () => <ChatPanel />,
    agents: () => <AgentsPanel />,
    avatars: () => <TeamCategoryPanel category="avatars" />,
    editors: () => <TeamCategoryPanel category="editors" />,
    smm: () => <TeamCategoryPanel category="smm" />,
  },
  intelligence: {
    "business-context": () => <BusinessContextPanel />,
    market: () => <MarketPanel />,
    icp: () => <IcpPanel />,
    competitors: () => <CompetitorsPanel />,
    "branding-associations": () => <BrandingAssociationsPanel />,
    "campaign-intelligence": () => <CampaignIntelligencePanel />,
    "proof-intelligence": () => <ProofIntelligencePanel />,
  },
  strategy: {
    "branding-strategy": () => <BrandingStrategyPanel />,
    "offer-strategy": () => <OfferStrategyPanel />,
    "money-model-strategy": () => <MoneyModelStrategyPanel />,
  },
  ideation: {
    generation: () => <GenerationPanel />,
    briefs: () => <BriefsPanel />,
  },
  media: {
    "image-library": () => <ImageLibraryPanel />,
    "video-library": () => <VideoLibraryPanel />,
    "copy-library": () => <CopyLibraryPanel />,
  },
  distribution: {
    organic: () => <OrganicPanel />,
    paid: () => <PaidPanel />,
  },
  conversion: {
    "primary-landing-pages": () => <PageBuilderPanel pageType="landing" />,
    "secondary-offer-pages": () => <PageBuilderPanel pageType="offer" />,
    "sales-agents": () => <SalesAgentsPanel />,
  },
  reporting: {
    organic: () => <OrganicReportingPanel />,
    paid: () => <PaidReportingPanel />,
    "landing-pages": () => <PagesReportingPanel pageType="landing" />,
    "offer-pages": () => <PagesReportingPanel pageType="offer" />,
    attribution: () => <AttributionPanel />,
    commentary: () => <CommentaryPanel />,
  },
};

const nodePanels: Record<string, () => ReactNode> = {
  dashboard: () => <DashboardPanel />,
  // distinct id from the agency dashboard; both live at a path segment
  // called "dashboard" but they are different pages
  "delivery-dashboard": () => <ClientDashboardPanel />,
  "proof-bank": () => <ProofBankPanel />,
  approvals: () => <ApprovalsPanel />,
  "prospects-leads": () => <ProspectsLeadsPanel />,
  onboarding: () => <OnboardingPanel />,
  contact: () => <ContactPanel />,
  brand: () => <BrandPanel />,
  integrations: () => <IntegrationsPanel />,
  contracts: () => <ContractsLegalPanel />,
  billing: () => <BillingSubscriptionPanel />,
  "audit-log": () => <AuditLogPanel />,
};

function getPanelBody(
  node: NavNode,
  activeTab: NavTab | undefined,
  sectionLabel: string,
): ReactNode {
  const renderPanel = activeTab
    ? nodeTabPanels[node.id]?.[activeTab.id]
    : nodePanels[node.id];
  if (renderPanel) return renderPanel();
  return <EmptyState label={sectionLabel} />;
}

export function Page({ node }: { node: NavNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabs = node.tabs;

  const requestedTab = searchParams.get("tab");
  const activeTab =
    tabs && (tabs.find((t) => t.id === requestedTab) ?? tabs[0]);

  const sectionLabel = activeTab ? activeTab.label : node.label;

  function handleTabChange(id: string) {
    if (!tabs) return;
    if (id === tabs[0].id) {
      setSearchParams({});
    } else {
      setSearchParams({ tab: id });
    }
  }

  return (
    <div>
      <PageHeader title={node.label} />
      {tabs && activeTab && (
        <div className="mb-6">
          <Tabs tabs={tabs} activeId={activeTab.id} onChange={handleTabChange} />
        </div>
      )}
      <div
        id={activeTab ? `tabpanel-${activeTab.id}` : undefined}
        role={activeTab ? "tabpanel" : undefined}
        aria-labelledby={activeTab ? `tab-${activeTab.id}` : undefined}
      >
        {getPanelBody(node, activeTab, sectionLabel)}
      </div>
    </div>
  );
}
