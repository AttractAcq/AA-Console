import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-a" }),
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("../../lib/useAgentJobs", () => ({
  useAgentJobs: () => ({ inFlight: [], recentFailures: [] }),
}));
vi.mock("../../lib/media", () => ({
  signPaths: async () => new Map(),
  fetchTextBodies: async () => new Map(),
}));
vi.mock("../../components/agents/AgentActivityBar", () => ({
  AgentActivityBar: () => null,
}));
vi.mock("./ProofArtifactsPanel", () => ({ ProofArtifactsPanel: () => null }));
vi.mock("../../components/proof/AddProofModal", () => ({
  AddProofModal: () => null,
}));
vi.mock("../../components/proof/ProofDetailModal", () => ({
  ProofDetailModal: () => null,
}));
vi.mock("../../components/MediaDetailModal", () => ({
  MediaDetailModal: () => null,
}));
vi.mock("../../components/briefs/ApproveAndBuildModal", () => ({
  ApproveAndBuildModal: () => null,
}));
vi.mock("../../components/briefs/BriefDetailModal", () => ({
  BriefDetailModal: () => null,
}));
import { ProofFactoryV2Panel } from "./ProofFactoryV2Panel";
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "request-1", error: null });
  const rows: Record<string, unknown[]> = {
    client_proof_assets: [
      {
        id: "proof-1",
        title: "Real customer result",
        client_id: "client-a",
        media_type: "text",
        source_category: "customers",
        source_kind: "Online Reviews",
        source_format: "single",
        usage_rights: "approved",
        created_at: "2026-10-18",
        body: "Real evidence",
      },
    ],
    client_briefs: [
      {
        id: "brief-1",
        proof_asset_id: "proof-1",
        title: "Proof brief",
        client_id: "client-a",
        body: "Evidence",
        status: "approved",
        media_type: "image",
        content_format: "single",
      },
    ],
    client_media_assets: [
      {
        id: "asset-1",
        brief_id: "brief-1",
        title: "Approved graphic",
        client_id: "client-a",
        review_status: "approved",
        media_type: "image",
        content_format: "single",
        created_at: "2026-10-18",
        storage_path: "test.png",
      },
    ],
  };
  from.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      in: () => chain,
      order: () => chain,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    };
    return chain;
  });
});
it("separates raw evidence from produced assets", async () => {
  render(<ProofFactoryV2Panel tab="assets" />);
  expect(await screen.findByText("Online Reviews")).toBeInTheDocument();
  expect(screen.queryByText("Approved graphic")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Produced" }));
  expect(screen.getByText("Approved graphic")).toBeInTheDocument();
  expect(screen.queryByText("Online Reviews")).not.toBeInTheDocument();
});
it("repurpose queues the selected parent's genuine source and direction", async () => {
  render(<ProofFactoryV2Panel tab="repurpose" />);
  await waitFor(() =>
    expect(screen.queryByText("Loading proof…")).not.toBeInTheDocument(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Repurpose" }));
  await userEvent.selectOptions(
    screen.getByLabelText(/Produced asset/),
    "asset-1",
  );
  await userEvent.type(
    screen.getByLabelText(/Production instructions/),
    "Create a concise quote graphic.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Prepare production brief" }),
  );
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "request_proof_production_v2",
      expect.objectContaining({
        p_client_id: "client-a",
        p_source_proof_id: "proof-1",
        p_source_asset_id: "asset-1",
        p_direction: "Create a concise quote graphic.",
      }),
    ),
  );
});
