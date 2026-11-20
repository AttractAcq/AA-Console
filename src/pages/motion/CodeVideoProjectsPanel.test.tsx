import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const { rpc, records } = vi.hoisted(() => ({
  rpc: vi.fn(),
  records: { projects: [] as Record<string, unknown>[],
    sources: [{ record_id: "source-1", title: "Reviewed offer", domain: "offer_strategy",
      observed_on: "2026-11-20", review_state: "supported" }],
    paused: true, audioPaused: true },
}));
vi.mock("../../lib/supabase", () => ({ supabase: {
  rpc,
  from: (table: string) => {
    let agentKey = "video_script";
    const query = { select: () => query,
      eq: (column: string, value: string) => {
        if (column === "agent_key") agentKey = value;
        return query;
      }, order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: table === "agents"
        ? { paused: agentKey === "video_audio" ? records.audioPaused : records.paused }
        : null,
        error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: table === "video_projects" ? records.projects : records.sources,
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
  records.paused = true; records.audioPaused = true; });

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
    source_snapshot: [], created_at: "2026-11-20" }];
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
    source_snapshot: [], created_at: "2026-11-20" }];
  render(<MemoryRouter><CodeVideoProjectsPanel /></MemoryRouter>);
  expect(await screen.findByText(/timing · Audio worker paused/)).toBeInTheDocument();
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
