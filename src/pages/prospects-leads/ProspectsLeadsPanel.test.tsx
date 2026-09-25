import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, insert } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), useParams: vi.fn(), insert: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));

import { ProspectsLeadsPanel } from "./ProspectsLeadsPanel";

const lead = (over: Record<string, unknown> = {}) => ({
  id: "lead-1", name: "Naledi K", contact: null, email: "naledi@example.com", phone: null,
  stage: "conversation", stage_at: "2026-09-01T00:00:00Z", next_action: "Send quote",
  next_action_due: "2026-09-30", opportunity_value: 12000, sale_value: null,
  cash_collected: null, source_channel: "Instagram reel", owner_member_id: null,
  appointment_at: null, appointment_outcome: null, ...over,
});

function chain(data: unknown[]) {
  const query = {
    select: () => query, eq: () => query, order: () => Promise.resolve({ data, error: null }),
    insert,
  };
  return query;
}

function show(leads: unknown[] = [lead()], archives: unknown[] = [], stalled: unknown[] = []) {
  from.mockImplementation((table: string) => chain(table === "client_leads" ? leads : table === "archived_leads" ? archives : []));
  rpc.mockImplementation((name: string) => Promise.resolve({ data: name === "stalled_leads" ? stalled : null, error: null }));
  return render(<ProspectsLeadsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  insert.mockResolvedValue({ error: null });
});

describe("AA lead funnel", () => {
  it("renders the nine stages in order and keeps Lost collapsed", async () => {
    show([lead(), lead({ id: "lost-1", name: "Lost prospect", stage: "lost" })]);
    await screen.findByText("Naledi K");
    const headings = within(screen.getByLabelText("Lead pipeline")).getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Profile Visits", "Followers", "Qualified", "Conversations", "Qualified Conversations",
      "Appointments", "Qualified Appointments", "Show Ups", "Cash Collected",
    ]);
    expect(screen.queryByText("Sale")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lost (1)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Lost prospect")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Lost (1)" }));
    expect(screen.getByText("Lost prospect")).toBeInTheDocument();
  });

  it("keeps stats, stalled warning and an archive count", async () => {
    show([lead()], [{ id: "archive-1", name: "Old", stage_at_archive: "qualified", lead: {}, events: [], archived_at: "2026-09-01", archived_by: null, reason: null }],
      [{ id: "lead-1", name: "Naledi K", stage: "conversation", days_in_stage: 4, next_action: null, overdue: false, owner_name: null }]);
    expect(await screen.findByText("Pipeline value")).toBeInTheDocument();
    expect(screen.getByText("Open leads")).toBeInTheDocument();
    expect(screen.getByText("Cash collected")).toBeInTheDocument();
    expect(screen.getByText(/1 lead with nothing scheduled next/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive (1)" })).toBeInTheDocument();
  });

  it("opens the same editor from the button and the card", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Naledi K" }));
    expect(screen.getByRole("dialog", { name: "Edit Naledi K" })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[0]!);
    await userEvent.click(screen.getByLabelText("Open Naledi K"));
    expect(screen.getByRole("dialog", { name: "Edit Naledi K" })).toBeInTheDocument();
  });

  it("saves details through update_lead and keeps the editor open", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Naledi K" }));
    await userEvent.clear(screen.getByLabelText(/Name/));
    await userEvent.type(screen.getByLabelText(/Name/), "Naledi Updated");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("update_lead", expect.objectContaining({
      p_lead_id: "lead-1", p_fields: expect.objectContaining({ name: "Naledi Updated" }),
    })));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit Naledi K" })).toBeInTheDocument();
  });

  it("moves through advance_lead and requires a reason for Lost", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Naledi K" }));
    await userEvent.click(screen.getByRole("tab", { name: "Move to" }));
    await userEvent.selectOptions(screen.getByLabelText("Move to stage"), "lost");
    await userEvent.click(screen.getByRole("button", { name: "Move lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Say why");
    expect(rpc).not.toHaveBeenCalledWith("advance_lead", expect.anything());
    await userEvent.type(screen.getByLabelText(/Note \(required/), "No longer interested");
    await userEvent.click(screen.getByRole("button", { name: "Move lead" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("advance_lead", {
      p_lead_id: "lead-1", p_stage: "lost", p_note: "No longer interested",
    }));
  });

  it("still moves a card by dragging", async () => {
    show();
    const card = await screen.findByLabelText("Open Naledi K");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(screen.getByLabelText("Appointments stage"), { dataTransfer });
    fireEvent.drop(screen.getByLabelText("Appointments stage"), { dataTransfer });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("advance_lead", { p_lead_id: "lead-1", p_stage: "appointment" }));
  });

  it("adds a timeline note", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Naledi K" }));
    await userEvent.click(screen.getByRole("tab", { name: /timeline/i }));
    await userEvent.type(screen.getByLabelText("Add note"), "Called and left voicemail");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("add_lead_note", { p_lead_id: "lead-1", p_note: "Called and left voicemail" }));
  });

  it("archives only through the editor", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Naledi K" }));
    await userEvent.click(screen.getByRole("tab", { name: /archive/i }));
    await userEvent.click(screen.getByRole("button", { name: "Archive this lead" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("archive_lead", { p_lead_id: "lead-1", p_reason: null }));
  });

  it("searches and views the archive, then recovers the original ID", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    show([lead()], [{
      id: "archived-1", name: "Old prospect", stage_at_archive: "qualified",
      lead: { id: "archived-1", name: "Old prospect", opportunity_value: 500 },
      events: [{ id: "event-1", kind: "note", body: "Called", from_stage: null, to_stage: null, occurred_at: "2026-09-01T00:00:00Z" }],
      archived_at: "2026-09-02T00:00:00Z", archived_by: null, reason: "No response",
    }]);
    await userEvent.click(await screen.findByRole("button", { name: "Archive (1)" }));
    expect(screen.getByText("Old prospect")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("Called")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Archive list/ }));
    await userEvent.click(screen.getByRole("button", { name: "Recover" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("recover_lead", { p_lead_id: "archived-1" }));
  });
});
