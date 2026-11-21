import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const { rpc, records } = vi.hoisted(() => ({
  rpc: vi.fn(),
  records: { projects: [] as Record<string, unknown>[],
    scopedProjectIds: [] as string[],
    sources: [{ record_id: "source-1", title: "Reviewed offer", domain: "offer_strategy",
      observed_on: "2026-11-20", review_state: "supported" }],
    brief: null as Record<string, unknown> | null,
    idea: null as Record<string, unknown> | null,
    routePackage: null as Record<string, unknown> | null,
    paused: true, audioPaused: true },
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    let agentKey = "video_script";
    let projectIds: string[] | null = null;
    const query = { select: () => query,
      eq: (column: string, value: string) => {
        if (column === "agent_key") agentKey = value;
        return query;
      }, in: (column: string, values: string[]) => {
        if (column === "id") projectIds = values;
        return query;
      }, order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: table === "agents"
        ? { paused: agentKey === "video_audio" ? records.audioPaused : records.paused }
        : table === "client_briefs" ? records.brief
          : table === "client_ideas" ? records.idea
            : table === "campaign_route_packages_v6" ? records.routePackage : null,
        error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: table === "video_project_status_v1"
          ? (projectIds ? records.projects.filter((project) => projectIds!.includes(String(project.id)))
            : records.projects)
          : table === "video_projects" ? records.scopedProjectIds.map((id) => ({ id }))
            : records.sources,
        error: null,
      }).then(resolve),
    };
    return query;
  },
} }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));
vi.mock("./CodeVideoAttachmentsPanel", () => ({
  CodeVideoAttachmentsPanel: () => null,
}));

import { CodeVideoProjectsPanel } from "./CodeVideoProjectsPanel";

beforeEach(() => { rpc.mockReset(); records.projects = [];
  records.scopedProjectIds = [];
  records.paused = true; records.audioPaused = true;
  records.brief = null; records.idea = null; records.routePackage = null; });

it("saves a manual draft and keeps storyboard start held while the agent is paused", async () => {
  rpc.mockResolvedValue({ data: { id: "project-1", stage: "draft", ir_version: 0 }, error: null });
  const user = userEvent.setup();
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  await user.type(screen.getByRole("textbox", { name: "Video idea" }),
    "Explain a reviewed service to prospective buyers.");
  await user.type(screen.getByRole("textbox", { name: "Video audience" }), "Local buyers");
  await user.click(screen.getByRole("button", { name: "Save code-video draft" }));
  expect(rpc).toHaveBeenCalledWith("create_video_project_draft_v1",
    expect.objectContaining({ p_client_id: "client-1", p_target_length_sec: 120,
      p_aspects: ["16:9"] }));
  expect(await screen.findByText(/Draft saved/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start storyboard" })).not.toBeInTheDocument();
});

it("shows supported sources but cannot start a draft with a paused worker", async () => {
  records.projects = [{ id: "project-1", idea: "Explain a reviewed service to buyers.",
    audience: "Local buyers", stage: "draft", stage_error: null, ir_version: 0,
    source_snapshot: [], created_at: "2026-11-20", scene_count: 0,
    audio_scene_count: 0, candidate_count: 0, accepted_candidate_count: 0,
    critic_loop_count: 0, asset_id: null, asset_review_status: null,
    human_approved_at: null }];
  const user = userEvent.setup();
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  await user.click(await screen.findByRole("button", { name: "Choose sources" }));
  expect(screen.getByText(/Reviewed offer/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start storyboard" })).toBeDisabled();
  expect(rpc).not.toHaveBeenCalled();
});

it("shows the paused audio worker on a queued narration project", async () => {
  records.projects = [{ id: "project-2", idea: "Explain reviewed evidence to buyers.",
    audience: "Local buyers", stage: "timing", stage_error: null, ir_version: 1,
    source_snapshot: [], created_at: "2026-11-20", scene_count: 3,
    audio_scene_count: 1, candidate_count: 0, accepted_candidate_count: 0,
    critic_loop_count: 0, asset_id: null, asset_review_status: null,
    human_approved_at: null }];
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByText(/timing · Audio worker paused/)).toBeInTheDocument();
  expect(screen.getByText(/Recorded: 3 scenes · audio ready 1\/3/)).toBeInTheDocument();
});

it("distinguishes an attached candidate from human asset approval", async () => {
  records.projects = [{ id: "project-3", idea: "Explain the reviewed offer to buyers.",
    audience: "Local buyers", stage: "attached", stage_error: null, ir_version: 2,
    source_snapshot: [], created_at: "2026-11-20", scene_count: 3,
    audio_scene_count: 3, candidate_count: 2, accepted_candidate_count: 2,
    critic_loop_count: 1, asset_id: "asset-3", asset_review_status: "pending",
    human_approved_at: null }];
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByText(/render candidates accepted 2\/2/)).toBeInTheDocument();
  expect(screen.getByText(/Attached asset: pending · human approval pending/))
    .toBeInTheDocument();
});

it("separates scheduled posts, recorded external references and missing receipts", async () => {
  records.projects = [{ id: "project-distribution", idea: "Explain the reviewed offer to buyers.",
    audience: "Local buyers", stage: "attached", stage_error: null, ir_version: 2,
    source_snapshot: [], created_at: "2026-11-20", scene_count: 3,
    audio_scene_count: 3, candidate_count: 1, accepted_candidate_count: 1,
    critic_loop_count: 1, asset_id: "asset-distribution", asset_review_status: "approved",
    human_approved_at: "2026-11-21T02:00:00Z", scheduled_post_count: 2,
    recorded_external_post_count: 1, last_recorded_external_post_at: "2026-11-21T03:00:00Z",
    unconfirmed_published_row_count: 1 }];
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByText(/Distribution: 2 scheduled or publishing/)).toHaveTextContent(
    "1 recorded external posts");
  expect(screen.getByText(/1 published rows lack an external reference/)).toHaveTextContent(
    "Provider read-back is a separate check");
});

it("saves the operator's exact ordered set of requested aspects", async () => {
  rpc.mockResolvedValue({ data: { id: "project-3", stage: "draft", ir_version: 0 }, error: null });
  const user = userEvent.setup();
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  await user.type(screen.getByRole("textbox", { name: "Video idea" }),
    "Explain reviewed services in several useful formats.");
  await user.type(screen.getByRole("textbox", { name: "Video audience" }), "Local buyers");
  await user.click(screen.getByRole("checkbox", { name: "Video aspect 9:16" }));
  await user.click(screen.getByRole("button", { name: "Save code-video draft" }));
  expect(rpc).toHaveBeenCalledWith("create_video_project_draft_v1",
    expect.objectContaining({ p_aspects: ["16:9", "9:16"] }));
});

it("binds an approved campaign brief to the current route package", async () => {
  records.brief = { id: "brief-1", title: "Campaign explainer",
    body: "Show the reviewed offer", media_type: "video",
    status: "approved", source_idea_id: "idea-1" };
  records.idea = { id: "idea-1", campaign_id: "campaign-1",
    archived_at: null };
  records.routePackage = { id: "route-2", version: 2 };
  rpc.mockResolvedValue({ data: { id: "project-4", stage: "draft", ir_version: 0 },
    error: null });
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[
    "/?videoBrief=brief-1&videoCampaign=campaign-1&videoRoute=organic",
  ]}><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByText(/Source brief: Campaign explainer · organic route v2/))
    .toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Video idea" }))
    .toHaveValue("Campaign explainer — Show the reviewed offer");
  await user.type(screen.getByRole("textbox", { name: "Video audience" }),
    "Local buyers");
  await user.click(screen.getByRole("button", { name: "Save code-video draft" }));
  expect(rpc).toHaveBeenCalledWith("create_video_project_draft_v1",
    expect.objectContaining({ p_brief_id: "brief-1",
      p_campaign_id: "campaign-1", p_route_package_id: "route-2" }));
});

it("keeps the inline campaign workspace on its brief and its own projects", async () => {
  records.brief = { id: "brief-1", title: "Campaign explainer",
    body: "Show the reviewed offer", media_type: "video",
    status: "approved", source_idea_id: "idea-1" };
  records.idea = { id: "idea-1", campaign_id: "campaign-1" };
  records.routePackage = { id: "route-2", version: 2 };
  records.scopedProjectIds = ["project-own"];
  records.projects = [
    { id: "project-own", idea: "Own approved brief", stage: "draft", ir_version: 0 },
    { id: "project-other", idea: "Another campaign video", stage: "draft", ir_version: 0 },
  ];
  rpc.mockResolvedValue({ data: { id: "project-own", stage: "draft" }, error: null });

  render(<MemoryRouter><CodeVideoProjectsPanel campaignBinding={{
    briefId: "brief-1", campaignId: "campaign-1", route: "organic",
  }} /></MemoryRouter>);

  expect(await screen.findByText("Own approved brief")).toBeInTheDocument();
  expect(screen.queryByText("Another campaign video")).not.toBeInTheDocument();
  expect(screen.getByText(/Source brief: Campaign explainer · organic route v2/))
    .toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox", { name: "Video audience" }), "Local buyers");
  await userEvent.click(screen.getByRole("button", { name: "Save code-video draft" }));
  expect(rpc).toHaveBeenCalledWith("create_video_project_draft_v1",
    expect.objectContaining({ p_brief_id: "brief-1", p_campaign_id: "campaign-1",
      p_route_package_id: "route-2" }));
});

it("holds a campaign video whose brief belongs to another campaign", async () => {
  records.brief = { id: "brief-1", title: "Campaign explainer",
    body: null, media_type: "video", status: "approved",
    source_idea_id: "idea-1" };
  records.idea = { id: "idea-1", campaign_id: "other-campaign",
    archived_at: null };
  records.routePackage = { id: "route-2", version: 2 };
  render(<MemoryRouter initialEntries={[
    "/?videoBrief=brief-1&videoCampaign=campaign-1&videoRoute=organic",
  ]}><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The brief and current campaign route could not be matched.");
  expect(screen.getByRole("button", { name: "Save code-video draft" }))
    .toBeDisabled();
});

it("does not silently create a manual video from an incomplete campaign link", async () => {
  render(<MemoryRouter initialEntries={[
    "/?videoCampaign=campaign-1&videoRoute=paid",
  ]}><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "A campaign video must name its approved brief.");
  expect(screen.getByRole("button", { name: "Save code-video draft" }))
    .toBeDisabled();
});
