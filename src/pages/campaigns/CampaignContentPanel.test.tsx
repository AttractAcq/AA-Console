import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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


// The whole chain for one piece of content — idea, the brief written from it,
// the assets produced from that brief — has to be visible in one place. Listed
// as three flat lists, a campaign with twelve ideas buried its single brief
// below all of them, and a briefed idea gave no sign its brief existed.
describe("the content chain, grouped by piece", () => {
  it("shows a brief underneath the idea it was written from", async () => {
    show();
    const ideaCard = (await screen.findByText("WhatsApp photo triage")).closest("div.rounded-md");
    expect(ideaCard).not.toBeNull();
    expect(within(ideaCard as HTMLElement).getByText("Campaign piece")).toBeInTheDocument();
  });

  it("shows the asset underneath the brief that produced it", async () => {
    show();
    const ideaCard = (await screen.findByText("WhatsApp photo triage")).closest("div.rounded-md");
    expect(within(ideaCard as HTMLElement).getByText(/Preview Finished piece/)).toBeInTheDocument();
    expect(within(ideaCard as HTMLElement).getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("says a brief is being written, so a briefed idea does not look failed", async () => {
    // Identical on screen to one whose brief agent died, unless it says so.
    ideas = [{ ...idea, status: "briefed" }];
    links = [];
    show();
    expect(await screen.findByText(/Brief being written/i)).toBeInTheDocument();
  });

  it("does not offer to brief an idea that already has one", async () => {
    ideas = [{ ...idea, status: "briefed" }];
    show();
    await screen.findByText("Campaign piece");
    expect(screen.queryByRole("button", { name: "Brief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & brief" })).not.toBeInTheDocument();
  });

  it("still shows a brief whose idea has gone, because it is still work done", async () => {
    // Orphans are dropped silently by a strict grouping, and somebody paid for
    // that brief.
    ideas = [];
    show();
    expect(await screen.findByText("Campaign piece")).toBeInTheDocument();
  });

  it("makes the brief a way in, not just a label", async () => {
    // The panel's job is to offer the brief for reading; what the viewer then
    // renders is BriefDetailModal's own business and is covered there.
    show();
    expect(await screen.findByRole("button", { name: "Campaign piece" })).toBeInTheDocument();
  });

  it("offers production from the brief in place", async () => {
    show();
    await screen.findByText("Campaign piece");
    expect(screen.getByRole("button", { name: /Approve & Build/ })).toBeInTheDocument();
  });
});

// The campaign chose the shape when it planned the piece. Showing the media
// type alone made a carousel indistinguishable from a single image on the
// page where you review that plan.
it("shows the format of a piece planned as a carousel", async () => {
  ideas = [{ ...idea, content_format: "carousel" }];
  show();
  expect(await screen.findByText("WhatsApp photo triage")).toBeInTheDocument();
  expect(screen.getByText("Carousel")).toBeInTheDocument();
});

it("shows the format of a piece planned as a story", async () => {
  ideas = [{ ...idea, content_format: "story" }];
  show();
  expect(await screen.findByText("WhatsApp photo triage")).toBeInTheDocument();
  expect(screen.getByText("Story")).toBeInTheDocument();
});

// Every piece on file is a single. A badge on all of them is decoration.
it("adds no badge to a single", async () => {
  ideas = [{ ...idea, content_format: "single" }];
  show();
  expect(await screen.findByText("WhatsApp photo triage")).toBeInTheDocument();
  expect(screen.queryByText("Single")).not.toBeInTheDocument();
});

describe("idea Details default collapsed", () => {
  it("hides the body until Details is opened", async () => {
    show();
    expect(await screen.findByText("WhatsApp photo triage")).toBeInTheDocument();
    expect(screen.queryByText(/Ask the spouse to send three photos/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Makes the booking step feel small/i)).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /Details for WhatsApp photo triage/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Ask the spouse to send three photos/i)).toBeInTheDocument();
    expect(screen.getByText(/Makes the booking step feel small/i)).toBeInTheDocument();
  });

  it("still shows production actions and the brief while Details is collapsed", async () => {
    // Collapsing Details must not hide the work — only the prose.
    show();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByText("Campaign piece")).toBeInTheDocument();
  });
});

describe("deleting a campaign content idea", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("deletes the idea through delete_client_idea and never the campaign", async () => {
    rpc.mockResolvedValue({ data: [{ deleted_briefs: 1, deleted_assets: 1 }], error: null });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete WhatsApp photo triage" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("delete_client_idea", { p_idea_id: "idea-1" }),
    );
    expect(rpc).not.toHaveBeenCalledWith("delete_client_campaign", expect.anything());
    expect(await screen.findByRole("status")).toHaveTextContent(/Idea deleted/i);
  });

  it("asks first, and does nothing if the answer is no", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete WhatsApp photo triage" }));
    await waitFor(() => expect(rpc).not.toHaveBeenCalledWith("delete_client_idea", expect.anything()));
  });

  it("surfaces a permission refusal from the RPC", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Only an admin can delete an idea." } });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Delete WhatsApp photo triage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only an admin can delete an idea/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
