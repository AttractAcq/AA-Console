import { useParams, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { Download } from "lucide-react";
import { ClientDashboardPanel } from "./dashboard/ClientDashboardPanel";
import type { ReactNode } from "react";
import type { NavNode, NavTab } from "../config/navigation";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/Button";
import { downloadModuleZip, downloadTabPdf, type ExportModule } from "../lib/moduleExport";
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
import { ContentPillarsPanel } from "./strategy/ContentPillarsPanel";
import { OfferStrategyPanel } from "./strategy/OfferStrategyPanel";
import { MoneyModelStrategyPanel } from "./strategy/MoneyModelStrategyPanel";
import { ProofBankPanel } from "./proof-bank/ProofBankPanel";
import { GenerationPanel } from "./ideation/GenerationPanel";
import { ContentArchivePanel } from "./archive/ContentArchivePanel";
import { ARCHIVE_DOMAINS, SimpleArchivePanel } from "./archive/SimpleArchivePanel";
import { BriefsPanel } from "./ideation/BriefsPanel";
import { ImageLibraryPanel } from "./media/ImageLibraryPanel";
import { StoryLibraryPanel } from "./media/StoryLibraryPanel";
import { CarouselLibraryPanel } from "./media/CarouselLibraryPanel";
import { VideoLibraryPanel } from "./media/VideoLibraryPanel";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel";
import { OrganicPanel } from "./distribution/OrganicPanel";
import { AssetsPanel } from "./distribution/AssetsPanel";
import { PaidPanel } from "./distribution/PaidPanel";
import { PageBuilderPanel } from "./conversion/PageBuilderPanel";
import { SalesOverviewPanel } from "./sales/SalesOverviewPanel";
import { CampaignExecutionPanel } from "./campaigns/CampaignExecutionPanel";
import { SitesPanel } from "./sites/SitesPanel";
import { GitHubSettingsPanel } from "./sites/GitHubSettingsPanel";
import { ClientEconomicsPanel } from "./economics/ClientEconomicsPanel";
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
import { RecruitmentPanel } from "./operations/RecruitmentPanel";
import { RecruitmentPagesPanel } from "./team/RecruitmentPagesPanel";
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
    recruitment: () => <RecruitmentPanel />,
    "recruitment-pages": () => <RecruitmentPagesPanel />,
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
    "content-pillars": () => <ContentPillarsPanel />,
    "offer-strategy": () => <OfferStrategyPanel />,
    "money-model-strategy": () => <MoneyModelStrategyPanel />,
  },
  ideation: {
    generation: () => <GenerationPanel />,
    briefs: () => <BriefsPanel />,
  },
  media: {
    "image-library": () => <ImageLibraryPanel />,
    "story-library": () => <StoryLibraryPanel />,
    "carousel-library": () => <CarouselLibraryPanel />,
    "video-library": () => <VideoLibraryPanel />,
    "copy-library": () => <CopyLibraryPanel />,
  },
  distribution: {
    "distribution-assets": () => <AssetsPanel />,
    organic: () => <OrganicPanel />,
    paid: () => <PaidPanel />,
  },
  sites: {
    overview: () => <SitesPanel />,
    settings: () => <GitHubSettingsPanel />,
  },
  sales: {
    overview: () => <SalesOverviewPanel />,
  },
  "campaign-execution": {
    overview: () => <CampaignExecutionPanel />,
  },
  economics: {
    overview: () => <ClientEconomicsPanel />,
  },
  conversion: {
    "primary-landing-pages": () => <PageBuilderPanel pageType="landing" />,
    "secondary-offer-pages": () => <PageBuilderPanel pageType="offer" />,
  },
  archive: {
    "content-production": () => <ContentArchivePanel />,
    pages: () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS.pages!} />,
    campaigns: () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS.campaigns!} />,
    "sales-agents": () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS["sales-agents"]!} />,
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
  const { clientId } = useParams<{ clientId: string }>();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const tabs = node.tabs;
  const exportModule: ExportModule | null =
    node.id === "intelligence" || node.id === "strategy" ? node.id : null;

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

  async function handleExport(all: boolean) {
    if (!clientId || !exportModule || !tabs || !activeTab) return;
    setExporting(true);
    setExportError(null);
    try {
      if (all) await downloadModuleZip(clientId, exportModule, tabs);
      else await downloadTabPdf(clientId, exportModule, activeTab);
    } catch (error) {
      setExportError(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      {exportModule && clientId ? (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-foreground">{node.label}</h1>
          </div>
          <Button icon={Download} disabled={exporting} onClick={() => void handleExport(true)}>
            {exporting ? "Preparing download…" : "Download all"}
          </Button>
        </div>
      ) : <PageHeader title={node.label} />}
      {tabs && activeTab && (
        <div className="mb-6">
          <Tabs tabs={tabs} activeId={activeTab.id} onChange={handleTabChange} />
        </div>
      )}
      {exportModule && clientId && activeTab && (
        <div className="mb-4 flex justify-end">
          <Button icon={Download} disabled={exporting} onClick={() => void handleExport(false)}>
            {exporting ? "Preparing download…" : "Download PDF"}
          </Button>
        </div>
      )}
      {exportError && <p role="alert" className="mb-4 text-sm text-destructive">{exportError}</p>}
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
