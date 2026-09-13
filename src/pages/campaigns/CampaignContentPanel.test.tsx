import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { from, rpc, insert, filters, build } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), insert: vi.fn(), filters: vi.fn(), build: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc, channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: vi.fn() } }));
vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: vi.fn() }));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map() }));
vi.mock("../ideation/GenerationPanel", () => ({ GenerationPanel: () => <p>Shared idea workflow</p> }));
vi.mock("../../components/briefs/ApproveAndBuildModal", () => ({ ApproveAndBuildModal: (props: unknown) => { build(props); return null; } }));
vi.mock("../../components/briefs/BriefDetailModal", () => ({ BriefDetailModal: () => null }));
vi.mock("../../components/MediaDetailModal", () => ({ MediaDetailModal: () => null }));
import { CampaignContentPanel } from "./CampaignContentPanel";
const brief = { id: "brief-1", title: "Campaign piece", status: "draft", media_type: "image", body: "Brief body", brief_ref: null };
const asset = { id: "asset-1", brief_id: "brief-1", title: "Finished piece", review_status: "pending", storage_path: "client-1/test.png" };
let linked = true;
let reviewStatus = "pending";
beforeEach(() => {
  vi.clearAllMocks(); linked = true; reviewStatus = "pending";
  insert.mockResolvedValue({ error: null }); rpc.mockResolvedValue({ error: null });
  from.mockImplementation((table: string) => {
    const chain = { select: () => chain, eq: (...args: unknown[]) => { filters(table, ...args); return chain; }, in: (...args: unknown[]) => { filters(table, ...args); return chain; }, order: () => chain, insert,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, data: table === "client_briefs" ? [brief] : table === "campaign_artifacts" ? (linked ? [{ brief_id: "brief-1", asset_id: null }] : []) : [{ ...asset, review_status: reviewStatus }] }).then(resolve),
    }; return chain;
  });
});
function show() { return render(<CampaignContentPanel clientId="client-1" campaignId="campaign-1" contentCount={2} onChanged={vi.fn()} />); }
it("loads only campaign-linked production and reuses the build modal", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Approve & Build" }));
  expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ brief, open: true }));
  expect(filters).toHaveBeenCalledWith("campaign_artifacts", "client_id", "client-1");
  expect(filters).toHaveBeenCalledWith("campaign_artifacts", "campaign_id", "campaign-1");
  expect(filters).toHaveBeenCalledWith("client_media_assets", "brief_id", ["brief-1"]);
  expect(filters).toHaveBeenCalledWith("client_media_assets", "client_id", "client-1");
});
it("attaches a selected brief to the current campaign and client", async () => {
  linked = false; show();
  await screen.findByText("Attach a brief to start production for this campaign.");
  fireEvent.change(screen.getByLabelText("Brief to attach"), { target: { value: "brief-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Attach brief" }));
  await waitFor(() => expect(insert).toHaveBeenCalledWith({ campaign_id: "campaign-1", client_id: "client-1", kind: "content", brief_id: "brief-1" }));
});
it("only marks approved assets ready and uses the normal review RPC", async () => {
  show();
  expect(await screen.findByText("Awaiting approval")).toBeInTheDocument();
  expect(screen.queryByText("Ready to distribute")).not.toBeInTheDocument();
  reviewStatus = "approved";
  fireEvent.click(screen.getByRole("button", { name: "Approve asset" }));
  expect(await screen.findByText("Ready to distribute")).toBeInTheDocument();
  expect(rpc).toHaveBeenCalledWith("review_media_asset", { p_asset_id: "asset-1", p_decision: "approved" });
});
it("requires a rejection reason and surfaces review failures", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Reject asset" }));
  expect(screen.getByRole("button", { name: "Confirm rejection" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Wrong logo" } });
  rpc.mockResolvedValue({ error: { message: "Review refused" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Review refused");
  expect(rpc).toHaveBeenCalledWith("review_media_asset", { p_asset_id: "asset-1", p_decision: "rejected", p_reason: "Wrong logo" });
});
it("opens ideation within the campaign", () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "Ideation" }));
  expect(screen.getByText("Shared idea workflow")).toBeInTheDocument();
});
