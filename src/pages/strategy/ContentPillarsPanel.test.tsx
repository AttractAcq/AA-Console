import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, useParams, callRuntime } = vi.hoisted(() => ({
  from: vi.fn(),
  useParams: vi.fn(),
  callRuntime: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { ContentPillarsPanel } from "./ContentPillarsPanel";

const pillar = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  slug: "honest-proof",
  name: "Honest proof",
  premise: "Proof beats volume.",
  belongs: "Named results.",
  does_not_belong: "Unattributed claims.",
  target_share: 25,
  active: true,
  ...over,
});

const insert = vi.fn();
const update = vi.fn();

function withRows(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: vi.fn(),
    insert,
    update,
  };
  // Two .order() calls, the second resolves.
  let calls = 0;
  (chain.order as ReturnType<typeof vi.fn>).mockImplementation(() => {
    calls += 1;
    return calls >= 2 ? Promise.resolve({ data: rows, error: null }) : chain;
  });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  insert.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
});

describe("an empty set", () => {
  beforeEach(() => from.mockImplementation(() => withRows([])));

  it("offers to generate one", async () => {
    render(<ContentPillarsPanel />);
    expect(await screen.findByRole("button", { name: /Generate with AI/i })).toBeInTheDocument();
    expect(screen.getByText(/No pillars yet/i)).toBeInTheDocument();
  });

  it("saves the set the generator proposes", async () => {
    callRuntime.mockResolvedValue({
      draft: {
        pillars: [
          { slug: "a", name: "A", premise: "p", belongs: "b", does_not_belong: "d", target_share: 50 },
          { slug: "b", name: "B", premise: "p", belongs: "b", does_not_belong: "d", target_share: 50 },
        ],
      },
    });
    render(<ContentPillarsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Generate with AI/i }));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(insert).toHaveBeenCalled());
    const rows = insert.mock.calls[0]![0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ client_id: "client-1", slug: "a", target_share: 50 });
  });
});

describe("a set that already exists", () => {
  beforeEach(() =>
    from.mockImplementation(() =>
      withRows([
        pillar({ id: "p1", slug: "a", name: "Honest proof", target_share: 50 }),
        pillar({ id: "p2", slug: "b", name: "The veneer door", target_share: 50 }),
      ]),
    ),
  );

  // Re-proposing over pillars somebody has edited would throw the edit away.
  // Replacing a set means retiring it first — a decision, not a button.
  it("does not offer to generate over it", async () => {
    render(<ContentPillarsPanel />);
    expect(await screen.findByDisplayValue("Honest proof")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate with AI/i })).not.toBeInTheDocument();
  });

  it("retires a pillar rather than deleting it", async () => {
    render(<ContentPillarsPanel />);
    await screen.findByDisplayValue("Honest proof");
    await userEvent.click(screen.getAllByRole("button", { name: "Retire" })[0]!);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ active: false }));
  });

  it("saves an edited boundary on blur", async () => {
    render(<ContentPillarsPanel />);
    const box = await screen.findByLabelText(/What does not for Honest proof/i);
    await userEvent.clear(box);
    await userEvent.type(box, "Anything without a named source.");
    await userEvent.tab();
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ does_not_belong: "Anything without a named source." }),
    );
  });

  it("warns when the shares stop adding up", async () => {
    from.mockImplementation(() =>
      withRows([
        pillar({ id: "p1", slug: "a", name: "A", target_share: 50 }),
        pillar({ id: "p2", slug: "b", name: "B", target_share: 10 }),
      ]),
    );
    render(<ContentPillarsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 3 active pillars/i);
  });
});
