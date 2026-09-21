import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, getUser, callRuntime } = vi.hoisted(() => ({
  callRuntime: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from,
    rpc,
    auth: { getUser },
    // The activity bar subscribes to job changes; nothing here tests realtime.
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("react-router-dom", () => ({
  useParams,
  // Link renders as an anchor so tests can still find navigation by role.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { SalesOverviewPanel } from "./SalesOverviewPanel";
import { liveStateOf, sinceLabel } from "./liveState";

type Conv = Partial<{
  id: string;
  sales_agent_id: string;
  contact_name: string | null;
  contact_email: string | null;
  qualified: boolean;
  handed_over: boolean;
  outcome: string | null;
  lead_id: string | null;
  started_at: string;
}>;

type Job = { status: string; input_id: string | null; created_at: string };

const built = (over: Record<string, unknown> = {}) => ({
  id: "sa-1",
  name: "Consult Qualifier",
  purpose: "Qualify and book full-arch consults",
  status: "live",
  role: "inbound_qualifier",
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
  approved_at: null,
  approved_by: null,
  created_at: "2026-09-08T09:00:00Z",
  ...over,
});

const conv = (over: Conv = {}): Conv => ({
  id: "c-1",
  sales_agent_id: "sa-1",
  contact_name: "Thandi M",
  contact_email: "thandi@example.com",
  qualified: false,
  handed_over: false,
  outcome: null,
  lead_id: null,
  started_at: new Date().toISOString(),
  ...over,
});

const update = vi.fn();
const eq = vi.fn();

function show(agents: unknown[] = [built()], convs: Conv[] = [], jobs: Job[] = []) {
  const chain = {
    eq,
    then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
  };
  eq.mockReturnValue(chain);
  update.mockReturnValue(chain);
  from.mockImplementation((table: string) => {
    // agent_jobs is read twice with different column sets: this panel asks for
    // input_id so a build maps to its own agent, while the activity bar asks
    // for agent_key. Answering both from one array crashes the bar, so branch
    // on the select rather than on the table.
    let forActivityBar = false;
    const data = () => {
      if (table === "client_sales_agents") return agents;
      if (table === "client_pages") return [{ id: "page-1", title: "Consult page" }];
      if (table === "sales_agent_conversations") return convs;
      return forActivityBar ? [] : jobs;
    };
    const chain = {
      select: (cols: string) => {
        forActivityBar = cols.includes("agent_key");
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: data() }),
      update,
      then: (r: (v: { data: unknown }) => unknown) => Promise.resolve({ data: data() }).then(r),
    };
    return chain;
  });
  return render(<SalesOverviewPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
});

describe("liveStateOf", () => {
  it("puts a job in flight above everything else, because the card is about to change", () => {
    expect(liveStateOf({ status: "live", built_at: "x" }, { status: "running" }).kind).toBe("building");
    expect(liveStateOf({ status: "draft", built_at: null }, { status: "queued" }).kind).toBe("building");
  });

  it("does not call an agent live when its build failed and it was never built", () => {
    // "Live" here would be the card lying about the only thing it is for.
    const state = liveStateOf({ status: "live", built_at: null }, { status: "failed" });
    expect(state.kind).toBe("failed");
    expect(state.label).toBe("Build failed");
  });

  it("says an unbuilt agent is unbuilt even with no job to explain it", () => {
    expect(liveStateOf({ status: "draft", built_at: null }, undefined).kind).toBe("unbuilt");
  });

  it("distinguishes a draft from a live agent once it is built", () => {
    expect(liveStateOf({ status: "live", built_at: "x" }, undefined).kind).toBe("live");
    expect(liveStateOf({ status: "live", built_at: "x" }, undefined).label).toMatch(
      /not approved/i,
    );
    expect(liveStateOf({ status: "draft", built_at: "x" }, undefined).label).toMatch(
      /not answering anyone/i,
    );
    expect(liveStateOf({ status: "retired", built_at: "x" }, undefined).kind).toBe("retired");
  });

  it("splits live from live-and-approved, because approval is a signature not a status", () => {
    expect(
      liveStateOf({ status: "live", built_at: "x", approved_at: "2026-09-15T12:00:00Z" }, undefined),
    ).toEqual({ kind: "approved", label: "Live — approved" });
    expect(liveStateOf({ status: "live", built_at: "x", approved_at: null }, undefined)).toEqual({
      kind: "live",
      label: "Live — not approved",
    });
    // A draft can be approved without going live; the badge stays draft.
    expect(
      liveStateOf({ status: "draft", built_at: "x", approved_at: "2026-09-15T12:00:00Z" }, undefined)
        .kind,
    ).toBe("draft");
  });

  it("keeps a completed job from being read as still building", () => {
    expect(liveStateOf({ status: "live", built_at: "x" }, { status: "completed" }).kind).toBe("live");
  });
});

describe("sinceLabel", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  it("reads in the unit a person would use", () => {
    expect(sinceLabel("2026-09-08T11:59:30Z", now)).toBe("just now");
    expect(sinceLabel("2026-09-08T11:30:00Z", now)).toBe("30m ago");
    expect(sinceLabel("2026-09-08T09:00:00Z", now)).toBe("3h ago");
    expect(sinceLabel("2026-09-05T12:00:00Z", now)).toBe("3d ago");
  });
  it("says never rather than showing an invalid date", () => {
    expect(sinceLabel(null, now)).toBe("never");
  });
});

describe("the overview grid", () => {
  it("shows a card per agent with what it has actually done", async () => {
    show(
      [built()],
      [
        conv({ id: "c-1", qualified: true, lead_id: "lead-1" }),
        conv({ id: "c-2", qualified: false, lead_id: "lead-2" }),
        conv({ id: "c-3", qualified: false, lead_id: null }),
      ],
    );
    expect(await screen.findByText("Consult Qualifier")).toBeInTheDocument();
    expect(screen.getByText("Inbound qualifier")).toBeInTheDocument();
    const card = screen.getByText("Consult Qualifier").closest("div") as HTMLElement;
    const cell = (label: string) =>
      within(card.parentElement as HTMLElement).getByText(label).parentElement?.textContent;
    // Talked to 3, qualified 1, leads 2 — three different questions.
    expect(cell("Talked to")).toContain("3");
    expect(cell("Qualified")).toContain("1");
    expect(cell("Leads")).toContain("2");
  });

  it("calls out a live agent that has not spoken to anyone, which a zero alone would hide", async () => {
    show([built({ status: "live" })], []);
    expect(await screen.findByText(/live, but has not spoken to anyone yet/i)).toBeInTheDocument();
  });

  it("shows a build in flight against the agent it belongs to, not the others", async () => {
    show(
      [built({ id: "sa-1", built_at: null, name: "Being built" }), built({ id: "sa-2", name: "Already built" })],
      [],
      [{ status: "running", input_id: "sa-1", created_at: "2026-09-08T11:00:00Z" }],
    );
    expect(await screen.findByText("Building…")).toBeInTheDocument();
    // Exactly one card claims to be building.
    expect(screen.getAllByText("Building…")).toHaveLength(1);
    expect(screen.getByText("Live — not approved")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been built", async () => {
    show([]);
    expect(await screen.findByText(/no sales agents built yet/i)).toBeInTheDocument();
  });
});

describe("putting an agent live", () => {
  it("offers Go live on a draft and Retire on a live one, never both", async () => {
    show([built({ status: "draft" })]);
    expect(await screen.findByRole("button", { name: "Go live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire" })).not.toBeInTheDocument();
  });

  it("writes the new status when an agent is put live", async () => {
    show([built({ status: "draft" })]);
    await userEvent.click(await screen.findByRole("button", { name: "Go live" }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "live" }));
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("approved_at");
    expect(await screen.findByText(/is live/i)).toBeInTheDocument();
  });
});

describe("opening an agent", () => {
  it("leads with what the agent may never say, above the script", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    // Assert both are present before comparing positions: indexOf returns -1
    // for a missing heading, which would make the ordering pass vacuously.
    expect(headings).toContain("Never says");
    expect(headings).toContain("Qualification");
    expect(headings.indexOf("Never says")).toBeLessThan(headings.indexOf("Qualification"));
  });

  it("numbers the qualification questions in the order they are asked", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("1. How long has this been bothering you?")).toBeInTheDocument();
    expect(dialog.getByText("3. Who else is part of this decision?")).toBeInTheDocument();
  });

  it("shows the conversations this agent had, and only this agent's", async () => {
    show([built()], [conv({ id: "c-1", contact_name: "Thandi M" }), conv({ id: "c-9", sales_agent_id: "other", contact_name: "Someone Else" })]);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Thandi M")).toBeInTheDocument();
    expect(dialog.queryByText("Someone Else")).not.toBeInTheDocument();
  });

  it("says why the conversation list is empty rather than implying failure", async () => {
    show([built()], []);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/once this agent is answering visitors/i),
    ).toBeInTheDocument();
  });
});

describe("approving an agent for public use", () => {
  it("shows approval state on a built card, and not on an unbuilt one", async () => {
    show([
      built({ id: "sa-1", name: "Ready" }),
      built({ id: "sa-2", name: "Still writing", built_at: null, status: "draft" }),
    ]);
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Not approved for public use")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve for public use" })).toHaveLength(1);
  });

  it("distinguishes live-unapproved from live-approved on the card", async () => {
    show([
      built({ id: "sa-1", name: "Waiting", approved_at: null }),
      built({
        id: "sa-2",
        name: "Signed off",
        approved_at: "2026-09-15T12:00:00Z",
        approved_by: "user-1",
      }),
    ]);
    expect(await screen.findByText("Live — not approved")).toBeInTheDocument();
    expect(screen.getByText("Live — approved")).toBeInTheDocument();
    expect(screen.getByText("Approved for public use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke approval" })).toBeInTheDocument();
  });

  it("does not write approval until the operator confirms, and the confirm shows the script", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Approve for public use" }));
    expect(update).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Approve for public use" });
    expect(dialog).toHaveTextContent("Consult Qualifier");
    expect(dialog).toHaveTextContent("Are you looking into replacing several teeth, or just one?");
    expect(dialog).toHaveTextContent("How long has this been bothering you?");
    expect(dialog).toHaveTextContent("It is too expensive");
    expect(dialog).toHaveTextContent("Never quote a price");
  });

  it("writes approved_at and approved_by, scoped to the client, and does not change status", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Approve for public use" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve for public use" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve for public use" }));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        approved_by: "user-1",
        approved_at: expect.any(String),
      }),
    );
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("status");
    expect(eq).toHaveBeenCalledWith("id", "sa-1");
    expect(eq).toHaveBeenCalledWith("client_id", "client-1");
    expect(await screen.findByText(/is approved for public use/i)).toBeInTheDocument();
  });

  it("offers approve from the detail drawer as well as the card", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const drawer = within(screen.getByRole("dialog", { name: "Consult Qualifier" }));
    expect(drawer.getByText(/not approved for public use/i)).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: "Approve for public use" })).toBeInTheDocument();
  });
});

describe("revoking approval", () => {
  it("clears the signature after confirm and does not write status", async () => {
    show([
      built({
        approved_at: "2026-09-15T12:00:00Z",
        approved_by: "user-1",
      }),
    ]);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke approval" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke approval" });
    expect(dialog).toHaveTextContent(/does not change its status \(live\)/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke approval" }));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ approved_at: null, approved_by: null }),
    );
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("status");
    expect(await screen.findByText(/has been revoked/i)).toBeInTheDocument();
  });
});

// The builder already reads the offer strategy, the ICP, the brand voice and
// the cleared proof. The purpose field is what it starts from — the moment
// this agent works in and where it has to stop.
describe("briefing a sales agent", () => {
  const ASK = {
    ask: "Meets somebody who has just read the full-arch page and is deciding whether to phone. Gets a time in the diary for a paid assessment. Never discusses price — the practice prices after imaging.",
  };

  async function openBriefer() {
    render(<SalesOverviewPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Build Sales Agent/i }));
    await userEvent.click(screen.getByRole("button", { name: "Generate with AI" }));
  }

  it("asks the runtime for the surface it was told to brief", async () => {
    callRuntime.mockResolvedValue({ draft: ASK });
    await openBriefer();

    await userEvent.selectOptions(screen.getByLabelText(/Which surface/i), "appointment_setter");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/briefs/draft", {
        clientId: "client-1",
        kind: "sales_agent",
        variant: "appointment_setter",
        notes: "",
      }),
    );
  });

  it("puts the ask into the purpose field", async () => {
    callRuntime.mockResolvedValue({ draft: ASK });
    await openBriefer();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByDisplayValue(ASK.ask)).toBeInTheDocument();
  });

  it("shows the runtime's refusal and stays open", async () => {
    callRuntime.mockRejectedValue(new Error("The ask is written in marketing register rather than saying anything."));
    await openBriefer();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/marketing register/i);
  });
});
