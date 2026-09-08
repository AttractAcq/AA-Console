import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from,
    rpc,
    // The activity bar subscribes to job changes; nothing here tests realtime.
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("react-router-dom", () => ({ useParams }));

import { SalesAgentsPanel } from "./SalesAgentsPanel";

type Conv = { sales_agent_id: string; qualified: boolean; lead_id: string | null };

const built = (over: Record<string, unknown> = {}) => ({
  id: "sa-1",
  name: "Consult Qualifier",
  purpose: "Qualify and book full-arch consults",
  status: "live",
  page_id: "page-1",
  greeting: "Are you looking into replacing several teeth, or just one?",
  system_prompt: "You are the front desk for a dental practice.",
  qualification: [
    { question: "How long has this been bothering you?", why: "urgency", good_answer: "years", disqualifier: "just curious" },
    { question: "What have you already tried?", why: "history", good_answer: "a plate", disqualifier: "nothing" },
    { question: "Who else is part of this decision?", why: "authority", good_answer: "just me", disqualifier: "unsure" },
  ],
  objections: [{ objection: "It is too expensive", response: "Compare it to what it replaces" }],
  booking_rule: "Book once they confirm they can attend in person.",
  escalation_rule: "Hand over on any clinical question or complaint.",
  guardrails: "Never quote a price. Never promise it is painless.",
  built_at: "2026-09-08T10:00:00Z",
  created_at: "2026-09-08T09:00:00Z",
  ...over,
});

/** The panel fires three selects; answer each by table name. */
function show(agents: unknown[] = [built()], convs: Conv[] = []) {
  from.mockImplementation((table: string) => {
    const data =
      table === "client_sales_agents" ? agents : table === "client_pages" ? [{ id: "page-1", title: "Consult page" }] : convs;
    // agent_jobs is queried by the activity bar, not by this panel.
    const rows = table === "agent_jobs" ? [] : data;
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows }),
      then: (r: (v: { data: unknown }) => unknown) => Promise.resolve({ data: rows }).then(r),
    };
    return chain;
  });
  return render(<SalesAgentsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("the list", () => {
  it("shows a built agent with what it asks and what it handles", async () => {
    show();
    expect(await screen.findByText("Consult Qualifier")).toBeInTheDocument();
    expect(screen.getByText(/3 qualification questions/)).toBeInTheDocument();
    expect(screen.getByText(/1 objection handled/)).toBeInTheDocument();
  });

  it("says an agent is still being built rather than showing it as empty", async () => {
    show([built({ built_at: null, greeting: null, qualification: [], objections: [] })]);
    expect(await screen.findByText(/waiting for the agent to build this/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /read the agent/i })).not.toBeInTheDocument();
  });

  it("says plainly when an agent has had no conversations", async () => {
    show();
    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
  });

  it("counts conversations, the ones that became leads, and the qualified ones separately", async () => {
    show(
      [built()],
      [
        { sales_agent_id: "sa-1", qualified: true, lead_id: "lead-1" },
        { sales_agent_id: "sa-1", qualified: false, lead_id: "lead-2" },
        { sales_agent_id: "sa-1", qualified: false, lead_id: null },
      ],
    );
    // Captured is not the same as qualified, and neither is the same as spoken to.
    expect(await screen.findByText("3 conversations · 2 became leads · 1 qualified")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been built", async () => {
    show([]);
    expect(await screen.findByText(/no sales agents built yet/i)).toBeInTheDocument();
  });
});

describe("reading the agent", () => {
  it("leads with what the agent may never say, above the script", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /read the agent/i }));
    const dialog = within(screen.getByRole("dialog"));

    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    // Assert both are present before comparing positions: indexOf returns -1
    // for a missing heading, which would make the ordering pass vacuously.
    expect(headings).toContain("Never says");
    expect(headings).toContain("Qualification");
    expect(headings.indexOf("Never says")).toBeLessThan(headings.indexOf("Qualification"));
    expect(dialog.getByText(/never quote a price/i)).toBeInTheDocument();
  });

  it("numbers the qualification questions in the order they are asked", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /read the agent/i }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("1. How long has this been bothering you?")).toBeInTheDocument();
    expect(dialog.getByText("3. Who else is part of this decision?")).toBeInTheDocument();
  });

  it("shows when it books and when it gives up and fetches a person", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /read the agent/i }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/book once they confirm/i)).toBeInTheDocument();
    expect(dialog.getByText(/hand over on any clinical question/i)).toBeInTheDocument();
  });
});
