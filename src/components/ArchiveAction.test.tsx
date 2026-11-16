import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc, from } }));
import { ArchiveAction } from "./ArchiveAction";

beforeEach(() => vi.clearAllMocks());

describe("client archive action", () => {
  it("records the exact client, domain and record only after confirmation", async () => {
    rpc.mockResolvedValue({ data: "2026-11-16T12:00:00Z", error: null });
    const done = vi.fn();
    render(<ArchiveAction clientId="client-1" table="market_opportunities" id="record-1"
      archived={false} noun="opportunity" onDone={done} onError={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(rpc).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(rpc).toHaveBeenCalledWith("set_client_archive_v8", {
      p_client_id: "client-1", p_table_name: "market_opportunities",
      p_record_id: "record-1", p_archive: true,
    });
    expect(done).toHaveBeenCalledOnce();
  });

  it("reports a rejected restore without claiming success", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Record state changed" } });
    const done = vi.fn(); const fail = vi.fn();
    render(<ArchiveAction clientId="client-1" table="lead_magnets" id="record-2"
      archived noun="magnet" onDone={done} onError={fail} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(rpc).toHaveBeenCalledWith("set_client_archive_v8", {
      p_client_id: "client-1", p_table_name: "lead_magnets",
      p_record_id: "record-2", p_archive: false,
    });
    expect(done).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("Record state changed");
  });

  it("keeps the record active when confirmation is cancelled", async () => {
    render(<ArchiveAction clientId="client-1" table="client_campaigns" id="record-3"
      archived={false} noun="campaign" onDone={vi.fn()} onError={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not claim an agency page was archived when no row changed", async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: "No rows" } });
    const chain = { update: vi.fn(), eq: vi.fn(), is: vi.fn(), select: vi.fn(), single };
    chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain); chain.select.mockReturnValue(chain);
    from.mockReturnValue(chain);
    const done = vi.fn(); const fail = vi.fn();
    render(<ArchiveAction table="client_pages" id="recruitment-1"
      archived={false} noun="page" onDone={done} onError={fail} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(chain.is).toHaveBeenCalledWith("client_id", null);
    expect(done).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith("No rows");
  });
});
