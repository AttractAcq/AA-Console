import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { from, rpc, update, eq, single, order, insert, positions, campaignOrder, campaignSingle, campaignNot, campaignIs, campaignEq, loadContentPillars } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), update: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn(),
  insert: vi.fn(), positions: vi.fn(), campaignOrder: vi.fn(), campaignSingle: vi.fn(),
  campaignNot: vi.fn(), campaignIs: vi.fn(), campaignEq: vi.fn(), loadContentPillars: vi.fn(),
}));
// Only the loaders are faked; MEDIA_TYPE_OPTIONS and useOptions are real,
// because the form renders through them.
vi.mock("../../lib/options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/options")>()),
  loadProofAssets: vi.fn().mockResolvedValue([]),
  loadContentPillars,
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  // Link renders as an anchor so tests can still find navigation by role.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));
vi.mock("../../lib/useAgentJobs", () => ({ useAgentJobs: () => ({ inFlight: [], recentFailures: [] }) }));
import { GenerationPanel } from "./GenerationPanel";
beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: () => chain, eq, update, single, order, insert, is: () => chain,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(positions()).then(resolve),
  };
  const campaignChain = {
    select: () => campaignChain, eq: campaignEq, not: campaignNot, is: campaignIs,
    order: campaignOrder, maybeSingle: campaignSingle,
  };
  from.mockImplementation((table: string) => table === "client_campaigns" ? campaignChain : chain);
  eq.mockReturnValue(chain); update.mockReturnValue(chain);
  campaignEq.mockReturnValue(campaignChain);
  campaignNot.mockReturnValue(campaignChain);
  campaignIs.mockReturnValue(campaignChain);
  campaignOrder.mockResolvedValue({ data: [{ id: "campaign-1", name: "Autumn launch", status: "planning" }], error: null });
  campaignSingle.mockResolvedValue({ data: { id: "campaign-1", built_at: "2026-09-20", content_count: 2, content_ideas_generated_at: "2026-09-20" }, error: null });
  positions.mockReturnValue({ data: [{ campaign_position: 1 }, { campaign_position: 2 }], error: null });
  insert.mockResolvedValue({ error: null });
  single.mockResolvedValue({ data: { id: "draft-1" }, error: null });
  rpc.mockResolvedValue({ error: null });
  loadContentPillars.mockResolvedValue([{ value: "pil-1", label: "Honest proof · 25% of the calendar" }]);
  order.mockResolvedValue({ data: ["draft", "approved", "briefed", "rejected"].map((status, i) => ({ id: `${status}-${i + 1}`, title: status + " idea", source: "manual", media_type: "image", status })) });
});

describe("manual idea campaign assignment", () => {
  async function openManualIdea() {
    render(<GenerationPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Manual Idea/i }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByRole("option", { name: "Autumn launch · planning" });
    await userEvent.type(dialog.getByLabelText(/^Idea/), "A human idea");
    await userEvent.selectOptions(dialog.getByLabelText(/^Destination/), "instagram");
    await userEvent.selectOptions(dialog.getByLabelText(/^Media type/), "image");
    await userEvent.selectOptions(dialog.getByLabelText(/^Format/), "single");
    return dialog;
  }

  it("keeps campaign optional", async () => {
    const dialog = await openManualIdea();
    await userEvent.click(dialog.getByRole("button", { name: "Add idea" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      client_id: "client-1", title: "A human idea", source: "manual", target_platform: "instagram",
    })));
    expect(insert.mock.calls[0][0]).not.toHaveProperty("campaign_id");
    expect(campaignSingle).not.toHaveBeenCalled();
  });

  it("assigns a built campaign and appends after its existing ideas", async () => {
    positions.mockReturnValue({ data: [{ campaign_position: 1 }, { campaign_position: 2 }, { campaign_position: 4 }], error: null });
    const dialog = await openManualIdea();
    expect(campaignEq).toHaveBeenCalledWith("client_id", "client-1");
    expect(campaignNot).toHaveBeenCalledWith("built_at", "is", null);
    expect(campaignIs).toHaveBeenCalledWith("archived_at", null);
    await userEvent.selectOptions(dialog.getByLabelText(/Assign to campaign/), "campaign-1");
    await userEvent.click(dialog.getByRole("button", { name: "Add idea" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      campaign_id: "campaign-1", campaign_position: 5,
    })));
    expect(await screen.findByText("Idea added to Autumn launch.")).toBeInTheDocument();
  });

  it("reserves positions for campaign ideas the planner has not generated yet", async () => {
    campaignSingle.mockResolvedValue({ data: { id: "campaign-1", built_at: "2026-09-20", content_count: 3, content_ideas_generated_at: null }, error: null });
    positions.mockReturnValue({ data: [], error: null });
    const dialog = await openManualIdea();
    await userEvent.selectOptions(dialog.getByLabelText(/Assign to campaign/), "campaign-1");
    await userEvent.click(dialog.getByRole("button", { name: "Add idea" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith(expect.objectContaining({ campaign_position: 4 })));
  });

  it("can add a manual idea after a full 30-piece planned batch", async () => {
    positions.mockReturnValue({ data: Array.from({ length: 30 }, (_, index) => ({ campaign_position: index + 1 })), error: null });
    const dialog = await openManualIdea();
    await userEvent.selectOptions(dialog.getByLabelText(/Assign to campaign/), "campaign-1");
    await userEvent.click(dialog.getByRole("button", { name: "Add idea" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith(expect.objectContaining({ campaign_position: 31 })));
  });

  it("refuses a campaign that stopped being built before save", async () => {
    campaignSingle.mockResolvedValue({ data: { id: "campaign-1", built_at: null, content_count: 2, content_ideas_generated_at: null }, error: null });
    const dialog = await openManualIdea();
    await userEvent.selectOptions(dialog.getByLabelText(/Assign to campaign/), "campaign-1");
    await userEvent.click(dialog.getByRole("button", { name: "Add idea" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("no longer built");
    expect(insert).not.toHaveBeenCalled();
  });

  it("shows the assigned campaign in the ideas table", async () => {
    order.mockResolvedValue({ data: [{
      id: "idea-1", title: "Campaign idea", source: "manual", media_type: "image",
      content_format: "single", status: "draft", campaign: { name: "Autumn launch" },
    }] });
    render(<GenerationPanel />);
    expect(await screen.findByText("Autumn launch")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Campaign" })).toBeInTheDocument();
  });
});
it("queues format-directed Auto Idea with a reel destination", async () => {
  render(<GenerationPanel />);
  await userEvent.click(await screen.findByRole("button", { name: /Auto Idea/i }));
  const dialog = within(screen.getByRole("dialog"));
  await userEvent.selectOptions(dialog.getByLabelText(/^Destination/), "instagram");
  await userEvent.selectOptions(dialog.getByLabelText(/^Media type/), "video");
  await userEvent.selectOptions(dialog.getByLabelText(/^Format/), "reel");
  await userEvent.click(dialog.getByRole("button", { name: "Generate ideas" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("enqueue_scoped_ideation", {
    p_client_id: "client-1", p_target_platform: "instagram", p_media_type: "video", p_content_format: "reel",
    p_campaign_id: null, p_idea_count: 5, p_input_table: null, p_input_id: null,
  }));
});
it("queues the chosen Auto Idea quantity and campaign", async () => {
  render(<GenerationPanel />);
  await userEvent.click(await screen.findByRole("button", { name: /Auto Idea/i }));
  const dialog = within(screen.getByRole("dialog"));
  await dialog.findByRole("option", { name: "Autumn launch · planning" });
  await userEvent.selectOptions(dialog.getByLabelText(/^Destination/), "instagram");
  await userEvent.selectOptions(dialog.getByLabelText(/^Media type/), "video");
  await userEvent.selectOptions(dialog.getByLabelText(/^Format/), "reel");
  await userEvent.selectOptions(dialog.getByLabelText(/Assign to campaign/), "campaign-1");
  await userEvent.clear(dialog.getByLabelText(/Number of ideas/));
  await userEvent.type(dialog.getByLabelText(/Number of ideas/), "8");
  await userEvent.click(dialog.getByRole("button", { name: "Generate ideas" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("enqueue_scoped_ideation", expect.objectContaining({
    p_idea_count: 8, p_campaign_id: "campaign-1",
  })));
});
/**
 * Every row action lives behind that row's menu now, so a test opens it and
 * then chooses. The trigger is named after the row, which is what keeps four
 * identical "Delete" items apart.
 */
async function openMenu(row: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${row}` }));
  return within(await screen.findByRole("menu", { name: `Actions for ${row}` }));
}
async function choose(row: string, action: string) {
  fireEvent.click((await openMenu(row)).getByRole("menuitem", { name: action }));
}
const closeMenu = () => fireEvent.keyDown(document, { key: "Escape" });

it("scopes manual approval to the selected draft and client, then refreshes", async () => {
  render(<GenerationPanel />);
  await choose("draft idea", "Approve");
  expect(await screen.findByText("Idea approved.")).toBeInTheDocument();
  expect(update).toHaveBeenCalledWith({ status: "approved" });
  expect(eq.mock.calls).toEqual(expect.arrayContaining([["id", "draft-1"], ["client_id", "client-1"], ["status", "draft"]]));
  expect(rpc).not.toHaveBeenCalled();
  expect(order).toHaveBeenCalledTimes(2);
});
it.each([
  ["Brief", "approved idea", "approved-2", "Brief queued."],
  ["Approve & brief", "draft idea", "draft-1", "Approved."],
])("%s uses the unchanged RPC", async (name, row, id, notice) => {
  render(<GenerationPanel />);
  await choose(row, name);
  expect(rpc).toHaveBeenCalledWith("approve_idea_and_generate_brief", { p_idea_id: id });
  expect(await screen.findByText(new RegExp(notice))).toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
});
it("disables actions while approving and recovers on a stale-row error", async () => {
  let finish!: (value: unknown) => void;
  single.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<GenerationPanel />);
  await choose("draft idea", "Approve");
  // Choosing closes the menu, so the trigger is where the row says it is
  // working — and every item inside it is disabled while that is true.
  const trigger = screen.getByRole("button", { name: "Actions for draft idea" });
  expect(trigger).toHaveTextContent("Working…");
  expect((await openMenu("draft idea")).getByRole("menuitem", { name: "Approving…" })).toBeDisabled();
  closeMenu();
  finish({ data: null, error: { message: "No draft row found" } });
  expect(await screen.findByText("No draft row found")).toHaveClass("text-destructive");
  await waitFor(() => expect(trigger).toHaveTextContent("Actions"));
  expect(screen.queryByText("Idea approved.")).not.toBeInTheDocument();
});
it("still offers delete for completed or rejected ideas, but not approve or brief", async () => {
  render(<GenerationPanel />);
  await screen.findByText("briefed idea");
  // Draft and approved still get approve/brief. Briefed and rejected only
  // get the things that are true of any row: archive and delete.
  const draft = await openMenu("draft idea");
  expect(draft.getByRole("menuitem", { name: "Approve" })).toBeInTheDocument();
  expect(draft.getByRole("menuitem", { name: "Approve & brief" })).toBeInTheDocument();
  closeMenu();
  const approved = await openMenu("approved idea");
  expect(approved.getByRole("menuitem", { name: "Brief" })).toBeInTheDocument();
  expect(approved.queryByRole("menuitem", { name: "Approve" })).not.toBeInTheDocument();
  closeMenu();
  for (const row of ["briefed idea", "rejected idea"]) {
    const menu = await openMenu(row);
    expect(menu.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    expect(menu.queryByRole("menuitem", { name: /Approve|Brief/ })).not.toBeInTheDocument();
    closeMenu();
  }
  // Every row has a menu, so every row can be deleted.
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(4);
});

describe("running ideation inside one pillar", () => {
  it("enqueues against the pillar, the same way proof seeds a run", async () => {
    render(<GenerationPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Pillar Idea/i }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText(/^Pillar/), "pil-1");
    await userEvent.selectOptions(dialog.getByLabelText(/^Destination/), "instagram");
    await userEvent.selectOptions(dialog.getByLabelText(/^Media type/), "video");
    await userEvent.selectOptions(dialog.getByLabelText(/^Format/), "reel");
    await userEvent.click(dialog.getByRole("button", { name: "Run agent" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("enqueue_scoped_ideation", {
        p_client_id: "client-1",
        p_target_platform: "instagram", p_media_type: "video", p_content_format: "reel",
        p_campaign_id: null, p_idea_count: null,
        p_input_table: "client_content_pillars",
        p_input_id: "pil-1",
      }),
    );
  });

  it("says where to define pillars when there are none", async () => {
    loadContentPillars.mockResolvedValue([]);
    render(<GenerationPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Pillar Idea/i }));
    expect(await screen.findByText(/no active content pillars yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Strategy first/i)).toBeInTheDocument();
  });
});

describe("deleting an idea", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("deletes through delete_client_idea after confirm", async () => {
    rpc.mockResolvedValue({ data: [{ deleted_briefs: 0, deleted_assets: 0 }], error: null });
    render(<GenerationPanel />);
    await choose("draft idea", "Delete");
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("delete_client_idea", { p_idea_id: "draft-1" }),
    );
    expect(await screen.findByText("Idea deleted.")).toBeInTheDocument();
    // Idea delete must never touch the campaign.
    expect(rpc).not.toHaveBeenCalledWith("delete_client_campaign", expect.anything());
  });

  it("asks first, and does nothing if the answer is no", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<GenerationPanel />);
    await choose("draft idea", "Delete");
    await waitFor(() => expect(rpc).not.toHaveBeenCalledWith("delete_client_idea", expect.anything()));
  });

  it("surfaces a permission refusal rather than pretending it worked", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Only an admin can delete an idea." } });
    render(<GenerationPanel />);
    await choose("draft idea", "Delete");
    expect(await screen.findByText(/Only an admin can delete an idea/i)).toHaveClass("text-destructive");
    expect(screen.queryByText("Idea deleted.")).not.toBeInTheDocument();
  });
});
