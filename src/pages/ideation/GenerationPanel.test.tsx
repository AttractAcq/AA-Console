import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { from, rpc, update, eq, single, order, loadContentPillars } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), update: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn(), loadContentPillars: vi.fn() }));
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
  const chain = { select: () => chain, eq, update, single, order, is: () => chain };
  from.mockReturnValue(chain); eq.mockReturnValue(chain); update.mockReturnValue(chain);
  single.mockResolvedValue({ data: { id: "draft-1" }, error: null });
  rpc.mockResolvedValue({ error: null });
  loadContentPillars.mockResolvedValue([{ value: "pil-1", label: "Honest proof · 25% of the calendar" }]);
  order.mockResolvedValue({ data: ["draft", "approved", "briefed", "rejected"].map((status, i) => ({ id: `${status}-${i + 1}`, title: status + " idea", source: "manual", media_type: "image", status })) });
});
it("scopes manual approval to the selected draft and client, then refreshes", async () => {
  render(<GenerationPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Idea approved.")).toBeInTheDocument();
  expect(update).toHaveBeenCalledWith({ status: "approved" });
  expect(eq.mock.calls).toEqual(expect.arrayContaining([["id", "draft-1"], ["client_id", "client-1"], ["status", "draft"]]));
  expect(rpc).not.toHaveBeenCalled();
  expect(order).toHaveBeenCalledTimes(2);
});
it.each([["Brief", "approved-2", "Brief queued."], ["Approve & brief", "draft-1", "Approved."]])("%s uses the unchanged RPC", async (name, id, notice) => {
  render(<GenerationPanel />);
  fireEvent.click(await screen.findByRole("button", { name }));
  expect(rpc).toHaveBeenCalledWith("approve_idea_and_generate_brief", { p_idea_id: id });
  expect(await screen.findByText(new RegExp(notice))).toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
});
it("disables actions while approving and recovers on a stale-row error", async () => {
  let finish!: (value: unknown) => void;
  single.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<GenerationPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Approve & brief" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Brief" })).toBeDisabled();
  finish({ data: null, error: { message: "No draft row found" } });
  expect(await screen.findByText("No draft row found")).toHaveClass("text-destructive");
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
  expect(screen.queryByText("Idea approved.")).not.toBeInTheDocument();
});
it("offers no actions for completed or rejected ideas", async () => {
  render(<GenerationPanel />);
  await screen.findByText("briefed idea");
  expect(screen.getAllByText("—")).toHaveLength(2);
});

describe("running ideation inside one pillar", () => {
  it("enqueues against the pillar, the same way proof seeds a run", async () => {
    render(<GenerationPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Pillar Idea/i }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText(/^Pillar/), "pil-1");
    await userEvent.click(dialog.getByRole("button", { name: "Run agent" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("enqueue_agent_job", {
        p_agent_key: "ideation",
        p_client_id: "client-1",
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
