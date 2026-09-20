import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", async (original) => ({
  ...await original<typeof import("react-router-dom")>(),
  useParams: () => ({ clientId: "client-1", category: "production" }),
}));
vi.mock("../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
vi.mock("../components/RuntimeHealthPanel", () => ({ RuntimeHealthPanel: () => null }));
import { MemoryRouter } from "react-router-dom";
import { ClientsPage } from "./ClientsPage";
import { PageBuilderPanel } from "./conversion/PageBuilderPanel";
import { GenerationPanel } from "./ideation/GenerationPanel";
import { BriefsPanel } from "./ideation/BriefsPanel";
import { AgentsPanel } from "./team/AgentsPanel";
import { CalendarPanel } from "./operations/CalendarPanel";
import { SopsPanel } from "./admin/SopsPanel";
import { CommentaryPanel } from "./reporting/CommentaryPanel";
import { ContractsLegalPanel } from "./account/ContractsLegalPanel";
import { AuditLogPanel } from "./account/AuditLogPanel";

import { DistributionBoard } from "../components/DistributionBoard";
import { MediaLibrary } from "../components/MediaLibrary";
import { ProofBankPanel } from "./proof-bank/ProofBankPanel";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel";
import { TeamCategoryPanel } from "./operations/TeamCategoryPanel";
import { RecruitmentPanel } from "./operations/RecruitmentPanel";
import { ActiveOrganicView, ActiveConversionView } from "./client/ClientViews";
import { BusinessContextPanel } from "./intelligence/BusinessContextPanel";
import { OnboardingPanel } from "./account/OnboardingPanel";
import { IntegrationsPanel } from "./account/IntegrationsPanel";
import { BillingSubscriptionPanel } from "./account/BillingSubscriptionPanel";
import { BrandPanel } from "./account/BrandPanel";
const OrganicDistribution = () => <DistributionBoard channel="organic" />;
const ImageLibrary = () => <MediaLibrary mediaType="image" />;
const EditorsTeam = () => <TeamCategoryPanel category="editors" />;
const Recruitment = () => <RecruitmentPanel />;
const ActiveOrganic = () => <ActiveOrganicView clientId="client-1" />;
const ActiveConversion = () => <ActiveConversionView clientId="client-1" />;

beforeEach(() => vi.clearAllMocks());
const panels = [OrganicDistribution, ImageLibrary, ProofBankPanel, ApprovalsPanel, EditorsTeam, Recruitment, ClientsPage, PageBuilderPanel, GenerationPanel, BriefsPanel, AgentsPanel, CalendarPanel, SopsPanel, CommentaryPanel, ContractsLegalPanel, AuditLogPanel, ActiveOrganic, ActiveConversion, BusinessContextPanel, OnboardingPanel, IntegrationsPanel, BillingSubscriptionPanel, BrandPanel];
for (const Component of panels) {
  it(`${Component.name} surfaces database errors and recovers on retry`, async () => {
    let fail = true;
    rpc.mockImplementation(() =>
      Promise.resolve(fail ? { data: null, error: { message: "column missing in schema cache" } } : { data: "house-1", error: null }),
    );
    from.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      // "is" and "not" are used for nullable filters such as
      // human_approved_at. A chain missing a builder method fails with
      // "query.is is not a function" instead of the error under test, which
      // hides the thing this file exists to check.
      for (const method of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "maybeSingle"]) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(fail ? { data: null, error: { message: "column missing in schema cache" } } : { data: [], error: null }).then(resolve, reject);
      return chain;
    });
    render(<MemoryRouter><Component /></MemoryRouter>);
    expect(await screen.findByRole("alert")).toHaveTextContent("column missing in schema cache");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
}
it("clients surfaces rejected network requests", async () => {
  from.mockImplementation(() => { throw new Error("Network unavailable"); });
  render(<MemoryRouter><ClientsPage /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
});
