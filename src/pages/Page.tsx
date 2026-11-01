import { ProofFactoryV2Panel } from "./proof-bank/ProofFactoryV2Panel";
import { LeadMagnetStudioPanel } from "./lead-magnet/LeadMagnetStudioPanel";
import { LeadCapturePanel } from "./sales/LeadCapturePanel";
import { CampaignPagePublishPanel } from "./sites/CampaignPagePublishPanel";
import { OfferLiveUsePanel } from "./offer/OfferLiveUsePanel";
import { MetaBuildApprovalPanel } from "./campaigns/MetaBuildApprovalPanel";
import { GoogleProfilePanel } from "./google-profile/GoogleProfilePanel";
import { GoogleAdsStudioPanel } from "./google-ads/GoogleAdsStudioPanel";
import { MetaProfilePanel } from "./distribution/MetaProfilePanel";
import { MotionScenesPanel } from "./motion/MotionScenesPanel";
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
import { CampaignInputsPanel } from "./intelligence/CampaignInputsPanel";
import { BrandingStrategyPanel } from "./strategy/BrandingStrategyPanel";
import { ContentPillarsPanel } from "./strategy/ContentPillarsPanel";
import { OfferStrategyPanel } from "./strategy/OfferStrategyPanel";
import { ServiceOffersPanel } from "./offer/ServiceOffersPanel";
import { MoneyModelStrategyPanel } from "./strategy/MoneyModelStrategyPanel";
import { GenerationPanel } from "./ideation/GenerationPanel";
import { ContentArchivePanel } from "./archive/ContentArchivePanel";
import { ARCHIVE_DOMAINS, SimpleArchivePanel } from "./archive/SimpleArchivePanel";
import { BriefsPanel } from "./ideation/BriefsPanel";
import { EditRepurposePanel } from "./media/EditRepurposePanel";
import { MotionDesignPanel } from "./motion/MotionDesignPanel";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel";
import { EngineInboxPanel } from "./approvals/EngineInboxPanel";
import { CampaignActionApprovalsPanel } from "./approvals/CampaignActionApprovalsPanel";
import { UnifiedApprovalInboxPanel } from "./approvals/UnifiedApprovalInboxPanel";
import { OrganicPanel } from "./distribution/OrganicPanel";
import { AssetsPanel } from "./distribution/AssetsPanel";
import { EnginePanel } from "./distribution/EnginePanel";
import { PaidPanel } from "./distribution/PaidPanel";
import { PageBuilderPanel } from "./conversion/PageBuilderPanel";
import { SalesOverviewPanel } from "./sales/SalesOverviewPanel";
import { SalesAccessRequestsPanel } from "./sales/SalesAccessRequestsPanel";
import { CampaignExecutionPanel } from "./campaigns/CampaignExecutionPanel";
import { SitesPanel } from "./sites/SitesPanel";
import { GitHubSettingsPanel } from "./sites/GitHubSettingsPanel";
import { ClientEconomicsPanel } from "./economics/ClientEconomicsPanel";
import { ProspectsLeadsPanel } from "./prospects-leads/ProspectsLeadsPanel";
import { OnboardingPanel } from "./account/OnboardingPanel";
import { ContactPanel } from "./account/ContactPanel";
import { BrandPanel } from "./account/BrandPanel";
import { IntegrationsPanel } from "./account/IntegrationsPanel";
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
import { RecruitmentDistributionPanel } from "./team/RecruitmentDistributionPanel";
import { CampaignsPanel } from "./operations/CampaignsPanel";
import { CalendarPanel } from "./operations/CalendarPanel";
import { ChatPanel } from "./team/ChatPanel";
import { AgentsPanel } from "./team/AgentsPanel";
import { FinancialsPanel } from "./admin/FinancialsPanel";
import { SopsPanel } from "./admin/SopsPanel";
import { SystemReadinessPanel } from "./admin/SystemReadinessPanel";
import { LiveSchemaParityPanel } from "./admin/LiveSchemaParityPanel";
import { ContentAssetTable } from "../components/content/ContentAssetTable";
import { ContentAssetsWorkspace, LEGACY_LIBRARY_TABS } from "../components/content/ContentAssetsWorkspace";
import { MarketOpportunitiesPanel } from "./opportunities/MarketOpportunitiesPanel";
import { ProofDistributionPanel } from "./proof-distribution/ProofDistributionPanel";

// Which of Intelligence OS's tabs belong to its Strategy half. The filter below
// is `strategyTabIds.has(tab.id) === (view === "strategy")`, so a tab missing
// from this set renders under Intelligence however it is grouped in
// navigation.ts -- which is why moving Offer Strategy is four edits, not one.
const strategyTabIds = new Set([
  "branding-strategy",
  "content-pillars",
  "offer-strategy",
  "money-model-strategy",
]);

const nodeTabPanels: Record<string, Record<string, () => ReactNode>> = {
  "intelligence-os": {
    "business-context": () => <BusinessContextPanel />,
    market: () => <MarketPanel />,
    icp: () => <IcpPanel />,
    competitors: () => <CompetitorsPanel />,
    "branding-associations": () => <BrandingAssociationsPanel />,
    "campaign-intelligence": () => <CampaignIntelligencePanel />,
    "campaign-inputs": () => <CampaignInputsPanel />,
    "proof-intelligence": () => <ProofIntelligencePanel />,
    "branding-strategy": () => <BrandingStrategyPanel />,
    "content-pillars": () => <ContentPillarsPanel />,
    "offer-strategy": () => <OfferStrategyPanel />,
    "money-model-strategy": () => <MoneyModelStrategyPanel />,
  },
  "market-opportunities": {
    discover: () => <MarketOpportunitiesPanel view="discover" />,
    evaluate: () => <MarketOpportunitiesPanel view="evaluate" />,
    strategize: () => <MarketOpportunitiesPanel view="strategize" />,
    activate: () => <MarketOpportunitiesPanel view="activate" />,
  },
  "proof-distribution": {
    destinations: () => <ProofDistributionPanel tab="destinations" />,
    placements: () => <ProofDistributionPanel tab="placements" />,
    rights: () => <ProofDistributionPanel tab="rights" />,
  },
  "proof-production-factory": {
    capture: () => <ProofFactoryV2Panel tab="capture" />,
    produce: () => <ProofFactoryV2Panel tab="produce" />,
    repurpose: () => <ProofFactoryV2Panel tab="repurpose" />,
    assets: () => <ProofFactoryV2Panel tab="assets" />,
  },
  // The stage journey bar is absent from the first four on purpose: it
  // belonged to a page that walked one asset through stages, and these are
  // four queues.
  "content-production-factory": {
    generation: () => <GenerationPanel showJourney={false} />,
    briefs: () => <BriefsPanel showJourney={false} />,
    // Create is the assets nobody has signed off, not the briefs waiting for
    // one: a brief with nothing made from it stays in Briefs, where
    // Approve & build starts the work.
    create: () => <ContentAssetTable approved={false} />,
    edit: () => <EditRepurposePanel showJourney={false} />,
    assets: () => <ContentAssetsWorkspace />,
  },
  "content-distribution": {
    "distribution-assets": () => <AssetsPanel />,
    organic: () => <OrganicPanel />,
    engine: () => <EnginePanel />,
  },
  "meta-ads-studio": {
    build: () => <MetaBuildApprovalPanel />,
    campaigns: () => <CampaignExecutionPanel />,
    paid: () => <PaidPanel />,
    reporting: () => <PaidReportingPanel />,
  },
  "meta-profile": {
    identities: () => <MetaProfilePanel tab="identities" />,
    profile: () => <MetaProfilePanel tab="profile" />,
    presence: () => <MetaProfilePanel tab="presence" />,
    organic: () => <OrganicPanel />,
    reporting: () => <OrganicReportingPanel />,
  },
  "offer-studio": {
    "live-use": () => <OfferLiveUsePanel />,
    offers: () => <ServiceOffersPanel />,
  },
  "website-studio": {
    publish: () => <CampaignPagePublishPanel />,
    "landing-pages": () => <PageBuilderPanel pageType="landing" />,
    "offer-pages": () => <PageBuilderPanel pageType="offer" />,
    sites: () => <SitesPanel />,
    // Offer results are not here: Attribution OS reports on offer pages.
    "landing-reporting": () => <PagesReportingPanel pageType="landing" />,
  },
  "google-ads-studio": {
    sheet: () => <GoogleAdsStudioPanel tab="sheet" />,
    account: () => <GoogleAdsStudioPanel tab="account" />,
    build: () => <GoogleAdsStudioPanel tab="build" />,
  },
  "google-profile": {
    location: () => <GoogleProfilePanel tab="location" />,
    reviews: () => <GoogleProfilePanel tab="reviews" />,
    posts: () => <GoogleProfilePanel tab="posts" />,
    metrics: () => <GoogleProfilePanel tab="metrics" />,
  },
  "lead-magnet-studio": {
    magnets: () => <LeadMagnetStudioPanel tab="magnets" />,
    build: () => <LeadMagnetStudioPanel tab="build" />,
    delivery: () => <LeadMagnetStudioPanel tab="delivery" />,
    optins: () => <LeadMagnetStudioPanel tab="optins" />,
  },
  // Capture leads, because where a lead came from is the question the old
  // page could never answer.
  "sales-os": {
    capture: () => <LeadCapturePanel />,
    leads: () => <><SalesAccessRequestsPanel /><ProspectsLeadsPanel /></>,
    agents: () => <SalesOverviewPanel />,
  },
  "motion-design": {
    scenes: () => <MotionScenesPanel tab="scenes" />,
    renders: () => <MotionScenesPanel tab="renders" />,
    brief: () => <MotionDesignPanel />,
  },
  "attribution-os": {
    overview: () => <AttributionPanel />,
    organic: () => <OrganicReportingPanel />,
    paid: () => <PaidReportingPanel />,
    "landing-pages": () => <PagesReportingPanel pageType="landing" />,
    "offer-pages": () => <PagesReportingPanel pageType="offer" />,
    commentary: () => <CommentaryPanel />,
    economics: () => <ClientEconomicsPanel />,
  },
  "approval-inbox": {
    "engine-inbox": () => <EngineInboxPanel />,
    assets: () => <ApprovalsPanel />,
    "campaign-actions": () => <CampaignActionApprovalsPanel />,
    unified: () => <UnifiedApprovalInboxPanel />,
  },
  admin: {
    "system-readiness": () => <SystemReadinessPanel />,
    "schema-parity": () => <LiveSchemaParityPanel />,
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
    "recruitment-distribution": () => <RecruitmentDistributionPanel />,
  },
  sites: {
    overview: () => <SitesPanel />,
    settings: () => <GitHubSettingsPanel />,
  },
  archive: {
    "content-production": () => <ContentArchivePanel />,
    pages: () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS.pages!} />,
    campaigns: () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS.campaigns!} />,
    "sales-agents": () => <SimpleArchivePanel domain={ARCHIVE_DOMAINS["sales-agents"]!} />,
  },
};

const nodePanels: Record<string, () => ReactNode> = {
  dashboard: () => <DashboardPanel />,
  // distinct id from the agency dashboard; both live at a path segment
  // called "dashboard" but they are different pages
  "delivery-dashboard": () => <ClientDashboardPanel />,
  "campaign-factory": () => <CampaignExecutionPanel />,
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
  // `?view=` is Intelligence OS's two halves. It used to carry v1/v2 as well,
  // for ten pages that had both; v1 is archived and v2 is simply the page.
  const view = searchParams.get("view") === "strategy" ? "strategy" : "intelligence";
  const tabs = node.id === "intelligence-os"
    ? node.tabs?.filter((tab) => strategyTabIds.has(tab.id) === (view === "strategy"))
    : node.tabs;
  const requestedTab = searchParams.get("tab");
  const assetLibrary = node.id === "content-production-factory"
    && requestedTab !== null && LEGACY_LIBRARY_TABS.has(requestedTab);
  const activeTab =
    tabs && (tabs.find((t) => t.id === (assetLibrary ? "assets" : requestedTab)) ?? tabs[0]);
  const v6Intelligence = node.id === "intelligence-os";
  const exportModule: ExportModule | null = v6Intelligence
    ? view === "strategy" ? "strategy" : "intelligence"
    : node.id === "intelligence" || node.id === "strategy" ? node.id : null;
  const sectionLabel = activeTab ? activeTab.label : node.label;
  const pageTitle = node.id === "intelligence-os" && view === "strategy" ? "Strategy" : node.label;

  function handleTabChange(id: string) {
    if (!tabs) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id === tabs[0].id) next.delete("tab");
      else next.set("tab", id);
      if (id !== "assets") {
        next.delete("asset");
        next.delete("library");
      }
      return next;
    });
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
            <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-foreground">{pageTitle}</h1>
          </div>
          <Button icon={Download} disabled={exporting} onClick={() => void handleExport(true)}>
            {exporting ? "Preparing download…" : v6Intelligence ? `Download ${view}` : "Download all"}
          </Button>
        </div>
      ) : <PageHeader title={pageTitle} />}
      {node.capability === "planned" && <p className="mb-4 text-sm text-muted-foreground">
        This module is visible in v6 and is not connected to an external service yet.
      </p>}
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
