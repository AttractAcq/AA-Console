import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { from, rpc, update, eq, single, order } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), update: vi.fn(), eq: vi.fn(), single: vi.fn(), order: vi.fn() }));
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
  const chain = { select: () => chain, eq, update, single, order };
  from.mockReturnValue(chain); eq.mockReturnValue(chain); update.mockReturnValue(chain);
  single.mockResolvedValue({ data: { id: "draft-1" }, error: null });
  rpc.mockResolvedValue({ error: null });
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
