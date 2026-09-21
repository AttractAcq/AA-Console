import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArchiveAction } from "./ArchiveAction";

const update = vi.fn();
const eq = vi.fn();

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        update(table, values);
        return { eq: (col: string, id: string) => { eq(col, id); return Promise.resolve({ error: null }); } };
      },
    }),
  },
}));

beforeEach(() => {
  update.mockReset();
  eq.mockReset();
});

describe("archiving", () => {
  // Archiving hides a campaign from the list somebody works from. Doing it
  // on a misclick, with no confirmation, is how a live campaign disappears.
  it("asks before archiving", () => {
    render(
      <ArchiveAction table="client_campaigns" id="c1" archived={false} noun="campaign" onDone={vi.fn()} onError={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Archive"));
    expect(screen.getByText("Archive this campaign?")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("stamps archived_at on the right row when confirmed", async () => {
    const onDone = vi.fn();
    render(
      <ArchiveAction table="client_campaigns" id="c1" archived={false} noun="campaign" onDone={onDone} onError={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const [table, values] = update.mock.calls[0]!;
    expect(table).toBe("client_campaigns");
    expect(typeof (values as { archived_at: unknown }).archived_at).toBe("string");
    expect(eq).toHaveBeenCalledWith("id", "c1");
    expect(onDone).toHaveBeenCalled();
  });

  it("backs out without writing anything", () => {
    render(
      <ArchiveAction table="client_pages" id="p1" archived={false} noun="page" onDone={vi.fn()} onError={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("restoring", () => {
  // Nothing was copied or deleted to archive it, so restoring is clearing
  // the stamp — which is what makes archiving safe to do without being sure.
  it("clears archived_at, and needs no confirmation", async () => {
    render(
      <ArchiveAction table="client_pages" id="p1" archived noun="page" onDone={vi.fn()} onError={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Restore"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![1]).toEqual({ archived_at: null });
  });

  it("offers Restore rather than Archive when already archived", () => {
    render(
      <ArchiveAction table="client_pages" id="p1" archived noun="page" onDone={vi.fn()} onError={vi.fn()} />,
    );
    expect(screen.getByText("Restore")).toBeTruthy();
    expect(screen.queryByText("Archive")).toBeNull();
  });
});
