import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { order, rpc, useParams } = vi.hoisted(() => ({
  order: vi.fn(), rpc: vi.fn(), useParams: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ order }) }), insert: vi.fn() }),
    rpc,
  },
}));
vi.mock("react-router-dom", () => ({ useParams }));

import { ProspectsLeadsPanel } from "./ProspectsLeadsPanel";

const lead = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  name: "Naledi K",
  contact: null, email: null, phone: null,
  stage: "conversation",
  stage_at: "2026-09-01T00:00:00Z",
  next_action: "Send the quote",
  next_action_due: "2026-09-30",
  opportunity_value: 12000,
  sale_value: null,
  cash_collected: null,
  source_channel: "Instagram reel",
  ...over,
});

function show(leads: unknown[] = [], stalled: unknown[] = []) {
  order.mockResolvedValue({ data: leads });
  rpc.mockResolvedValue({ data: stalled });
  return render(<ProspectsLeadsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("the chain the board shows", () => {
  // Attention is impressions against a post, not a pipeline stage. Putting it
  // here would double-count it and add a column nobody can act on.
  it("starts at Lead, because attention is not a stage", async () => {
    show([lead()]);
    expect(await screen.findByText("Lead")).toBeInTheDocument();
    expect(screen.queryByText(/attention/i)).not.toBeInTheDocument();
  });

  it("runs the whole chain through to Cash", async () => {
    show([lead()]);
    await screen.findByText("Lead");
    for (const label of ["Conversation", "Qualified", "Appointment", "Showed", "Sale", "Cash"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("keeps money out of the pipeline count once it is collected", async () => {
    show([lead({ opportunity_value: 5000 }), lead({ stage: "cash", opportunity_value: 9000, cash_collected: 9000 })]);
    await screen.findByText("Pipeline value");
    expect(screen.getByText("R5,000")).toBeInTheDocument();
    expect(screen.getByText("R9,000")).toBeInTheDocument();
  });
});

describe("what is sitting still", () => {
  // The question the tool exists to answer, and it leads the page: a board
  // shows the shape, this shows the work.
  it("leads with the stalled leads rather than the board", async () => {
    show([lead()], [{
      id: "l1", name: "Thabo M", stage: "qualified_conversation",
      days_in_stage: 9, next_action: null, next_action_due: null,
      overdue: false, owner_name: null,
    }]);
    expect(await screen.findByText(/1 lead with nothing scheduled next/)).toBeInTheDocument();
    expect(screen.getByText(/Thabo M/)).toBeInTheDocument();
    expect(screen.getByText(/9 days there/)).toBeInTheDocument();
  });

  // An unowned stalled lead is worse than a stalled one, and saying "nobody"
  // is more useful than leaving the space blank.
  it("says when nobody is assigned", async () => {
    show([lead()], [{
      id: "l1", name: "Thabo M", stage: "lead", days_in_stage: 3,
      next_action: null, next_action_due: null, overdue: false, owner_name: null,
    }]);
    expect(await screen.findByText(/nobody assigned/)).toBeInTheDocument();
  });

  it("names the overdue action rather than only flagging it", async () => {
    show([lead()], [{
      id: "l1", name: "Thabo M", stage: "appointment", days_in_stage: 2,
      next_action: "Call back", next_action_due: "2026-09-01", overdue: true, owner_name: "Sipho",
    }]);
    expect(await screen.findByText(/"Call back" overdue/)).toBeInTheDocument();
  });

  it("shows no warning when nothing is stalled", async () => {
    show([lead()], []);
    await screen.findByText("Lead");
    expect(screen.queryByText(/nothing scheduled next/)).not.toBeInTheDocument();
  });

  // On the card too: a lead with no next action is stalled whatever its stage.
  it("marks a lead with no next action on its own card", async () => {
    show([lead({ next_action: null })]);
    expect(await screen.findByText("nothing scheduled")).toBeInTheDocument();
  });
});

describe("where a lead came from", () => {
  // Without this, revenue can never be traced back to the content that made it.
  it("shows the source on the card", async () => {
    show([lead()]);
    expect(await screen.findByText(/Instagram reel/)).toBeInTheDocument();
  });

  it("says plainly when there are no leads at all", async () => {
    show([]);
    expect(await screen.findByText(/Nothing has come in from a page, a post or a referral/)).toBeInTheDocument();
  });
});
