import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, update, filters, build } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  filters: vi.fn(),
  build: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from,
    rpc,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("../../lib/media", () => ({ signPaths: async () => new Map() }));
vi.mock("../../components/briefs/ApproveAndBuildModal", () => ({ ApproveAndBuildModal: (props: unknown) => { build(props); return null; } }));
vi.mock("../../components/briefs/BriefDetailModal", () => ({ BriefDetailModal: () => null }));
vi.mock("../../components/MediaDetailModal", () => ({ MediaDetailModal: () => null }));

import { CampaignContentPanel } from "./CampaignContentPanel";

const idea = {
  id: "idea-1",
  client_id: "client-1",
  campaign_id: "campaign-1",
  campaign_position: 1,
  title: "WhatsApp photo triage",
  body: "Ask the spouse to send three photos, then book the written plan assessment.",
  media_type: "text",
  source: "auto",
  source_question: "whatsapp",
  strategic_reason: "Makes the booking step feel small.",
  status: "draft",
  job_id: null,
  proof_id: null,
  created_by: null,
  content_territory: "Campaign: Christmas Sale",
  created_at: "2026-09-13T08:00:00Z",
  updated_at: "2026-09-13T08:00:00Z",
};
const brief = { id: "brief-1", source_idea_id: "idea-1", title: "Campaign piece", status: "draft", media_type: "text", body: "Brief body", brief_ref: null };
const asset = { id: "asset-1", brief_id: "brief-1", title: "Finished piece", review_status: "pending", storage_path: "client-1/test.png" };

let ideas: unknown[] = [idea];
let links: unknown[] = [{ brief_id: "brief-1", asset_id: null }];
let reviewStatus = "pending";

beforeEach(() => {
  vi.clearAllMocks();
  ideas = [idea];
  links = [{ brief_id: "brief-1", asset_id: null }];
  reviewStatus = "pending";
  update.mockReturnValue(undefined);
  rpc.mockResolvedValue({ error: null });
  from.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      update: (value: unknown) => { update(value); return chain; },
      eq: (...args: unknown[]) => { filters(table, ...args); return chain; },
      in: (...args: unknown[]) => { filters(table, ...args); return chain; },
      order: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        error: null,
        data: table === "client_ideas"
          ? ideas
          : table === "campaign_artifacts"
            ? links
            : table === "client_briefs"
              ? [brief]
              : [{ ...asset, review_status: reviewStatus }],
      }).then(resolve),
    };
    return chain;
  });
});

function show(over: Partial<Parameters<typeof CampaignContentPanel>[0]> = {}) {
  return render(<CampaignContentPanel
    clientId="client-1"
    campaignId="campaign-1"
    contentCount={2}
    builtAt="2026-09-13T08:00:00Z"
    contentIdeasGeneratedAt="2026-09-13T08:01:00Z"
    onChanged={vi.fn()}
    {...over}
  />);
}

it("loads campaign-specific ideas and the production linked to their briefs", async () => {
  show();
  expect(await screen.findByText("WhatsApp photo triage")).toBeInTheDocument();
  expect(screen.getByText("Campaign piece")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve & brief" })).toBeInTheDocument();
  expect(filters).toHaveBeenCalledWith("client_ideas", "campaign_id", "campaign-1");
  expect(filters).toHaveBeenCalledWith("campaign_artifacts", "campaign_id", "campaign-1");
  expect(filters).toHaveBeenCalledWith("client_media_assets", "brief_id", ["brief-1"]);
});

it("queues campaign idea generation for an older planned campaign", async () => {
  ideas = [];
  links = [];
  show({ contentIdeasGeneratedAt: null });
  fireEvent.click(await screen.findByRole("button", { name: "Generate campaign ideas" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("enqueue_agent_job", {
    p_agent_key: "campaign_plan",
    p_client_id: "client-1",
    p_input_table: "client_campaigns",
    p_input_id: "campaign-1",
  }));
  expect(await screen.findByRole("status")).toHaveTextContent("creating the campaign-specific content ideas");
});

it("manual approval is tightly scoped to the campaign idea", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ status: "approved" }));
  expect(filters).toHaveBeenCalledWith("client_ideas", "id", "idea-1");
  expect(filters).toHaveBeenCalledWith("client_ideas", "client_id", "client-1");
  expect(filters).toHaveBeenCalledWith("client_ideas", "campaign_id", "campaign-1");
  expect(filters).toHaveBeenCalledWith("client_ideas", "status", "draft");
});

it("uses the existing combined RPC for campaign briefing", async () => {
  ideas = [{ ...idea, status: "approved" }];
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Brief" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("approve_idea_and_generate_brief", { p_idea_id: "idea-1" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Brief queued");
});

it("only marks approved assets ready and reuses the normal review RPC", async () => {
  show();
  expect(await screen.findByText("Awaiting approval")).toBeInTheDocument();
  expect(screen.getByText("0 ready to distribute · 2 pieces planned · 1 campaign ideas")).toBeInTheDocument();
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
