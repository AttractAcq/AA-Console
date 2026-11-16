import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
const { from, rpc, enqueueAgentJob } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), enqueueAgentJob: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc }, enqueueAgentJob }));
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
  enqueueAgentJob.mockResolvedValue(undefined);
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
    screen.getByRole("button", { name: "Start production" }),
  );
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "request_proof_auto_production",
      expect.objectContaining({
        p_client_id: "client-a",
        p_source_proof_id: "proof-1",
        p_source_asset_id: "asset-1",
        p_direction: "Create a concise quote graphic.",
      }),
    ),
  );
});
it("preserves the human handoff without automatically building", async () => {
  render(<ProofFactoryV2Panel tab="repurpose" />);
  await waitFor(() => expect(screen.queryByText("Loading proof…")).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Repurpose" }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /^Production/ }), "human");
  await userEvent.selectOptions(screen.getByLabelText(/Produced asset/), "asset-1");
  await userEvent.type(screen.getByLabelText(/Production instructions/), "Have our editor prepare the quote graphic.");
  await userEvent.click(screen.getByRole("button", { name: "Start production" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_proof_production_v2", expect.objectContaining({p_source_proof_id:"proof-1"})));
  expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_quality");
});

it("shows proof derivatives awaiting human review separately from completed production", async () => {
  const fixture: Record<string, unknown[]> = {
    client_proof_assets: [{ id: "proof-1", title: "Customer result", client_id: "client-a",
      media_type: "text", body: "Evidence", usage_rights: "approved" }],
    client_briefs: [{ id: "brief-1", source_idea_id: "idea-1", proof_asset_id: "proof-1",
      client_id: "client-a", status: "complete", media_type: "image" }],
    proof_production_requests: [{ id: "request-1", client_id: "client-a", source_proof_id: "proof-1",
      idea_id: "idea-1", destination: "Organic Social Media", auto_produce: true,
      production_status: "complete", production_error: null }],
    proof_production_counts_v7: [{ request_id: "request-1", attempts: 2, produced: 1,
      rejected: 1, revised: 1, awaiting_review: 1, human_approved: 0,
      render_cost_usd: 0.12 }],
    proof_production_attempts_v7: [{ attempt_id: "attempt-1", request_id: "request-1",
      asset_id: null, attempt_kind: "creative_render", attempt_status: "failed",
      cost_usd: 0.04, latency_seconds: 12, revised: true,
      human_review_status: null }],
    client_media_assets: [], agent_jobs: [],
  };
  from.mockImplementation((table: string) => {
    const chain = { select: () => chain, eq: () => chain, not: () => chain,
      in: () => chain, order: () => chain,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: fixture[table] ?? [], error: null }).then(resolve) };
    return chain;
  });
  render(<ProofFactoryV2Panel tab="produce" />);
  expect(await screen.findByText("Ready for human review")).toBeInTheDocument();
  expect(screen.getByText(/1 requested · 1 produced · 1 failed or rejected attempts · 1 revised · 1 awaiting human review · 0 human approved/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Compare attempts" }));
  expect(screen.getByText(/creative render · failed · revision/)).toBeInTheDocument();
  expect(screen.getByText("12s")).toBeInTheDocument();
  expect(screen.getByText("$0.04")).toBeInTheDocument();
});
it("can still send the proof discovery agent looking, which only v1 could", async () => {
  render(<ProofFactoryV2Panel tab="assets" />);
  expect(await screen.findByText("Online Reviews")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Find proof online" }));
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(enqueueAgentJob).toHaveBeenCalledWith({
      agentKey: "proof_discovery",
      clientId: "client-a",
    }),
  );
});
