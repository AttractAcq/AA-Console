import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc } }));

import { ArchivedDmReturnsPanel } from "./ArchivedDmReturnsPanel";

beforeEach(() => rpc.mockReset());

describe("archived DM returns", () => {
  it("shows exact retained messages without offering an identity decision or reply", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "list_archived_dm_returns_v11"
      ? { data: [{ conversation_id: "dm-1", archived_lead_id: "old-1", platform: "instagram",
        display_name: "Returning contact", last_inbound_at: "2026-11-19T12:00:00Z", unread_inbound: 1 }], error: null }
      : { data: { client_id: "client-1", conversation_id: "dm-1", archived_name: "Archived original",
        display_name: "Returning contact", platform: "instagram", source_hash: "a".repeat(64),
        messages: [{ id: "message-1", direction: "inbound", body: "I am back",
          occurred_at: "2026-11-19T12:00:00Z" }] }, error: null }));
    render(<ArchivedDmReturnsPanel clientId="client-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "View exact messages" }));
    expect(await screen.findByRole("dialog", { name: "Archived DM identity review" })).toHaveTextContent("I am back");
    expect(screen.queryByRole("button", { name: /approve|recover|reply/i })).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("archived_dm_return_review_packet_v11",
      { p_conversation_id: "dm-1" });
  });

  it("discards a late read from the previous client", async () => {
    let finishOld!: (value: unknown) => void;
    rpc.mockImplementation((_name: string, args?: { p_client_id: string }) =>
      args?.p_client_id === "client-old"
        ? new Promise((resolve) => { finishOld = resolve; })
        : Promise.resolve({ data: [], error: null }));
    const { rerender } = render(<ArchivedDmReturnsPanel clientId="client-old" />);
    rerender(<ArchivedDmReturnsPanel clientId="client-new" />);
    await screen.findByText("No held DM returns.");
    finishOld({ data: [{ conversation_id: "dm-old", display_name: "Previous client" }], error: null });
    await waitFor(() => expect(screen.queryByText(/Previous client/)).not.toBeInTheDocument());
  });

  it("reports a failed source read instead of showing an empty queue", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "read unavailable" } });
    render(<ArchivedDmReturnsPanel clientId="client-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("No held DM returns.")).not.toBeInTheDocument();
  });
});
