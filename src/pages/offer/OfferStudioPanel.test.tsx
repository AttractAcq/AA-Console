import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offer Studio as one page.
 *
 * Offers is the read/review table. Build chooses a source before exposing
 * manual or agent drafting. Source binding still happens in the database.
 */
const { from, insert, rpc } = vi.hoisted(() => ({
  from: vi.fn(), insert: vi.fn(), rpc: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({
  supabase: { from, rpc: (...a: unknown[]) => rpc(...(a as [])) },
}));

import { OfferStudioPanel } from "./OfferStudioPanel";

const offer = (over: Record<string, unknown> = {}) => ({
  id: "offer-1", client_id: "client-1", service_name: "Garage conversion",
  kind: "main", created_at: "2026-10-01T00:00:00Z", ...over,
});
const version = (over: Record<string, unknown> = {}) => ({
  id: "ver-2", offer_id: "offer-1", client_id: "client-1", version: 2,
  idempotency_key: "k2", audience: null, promise: null, inclusions: [],
  exclusions: [], price_amount: 4500, currency: "EUR",
  delivery_cost_estimate: null, claims: [], content_hash: "h2",
  created_at: "2026-10-02T00:00:00Z", ...over,
});
const drift = (over: Record<string, unknown> = {}) => ({
  client_id: "client-1", offer_id: "offer-1", service_name: "Garage conversion",
  offer_version_id: "ver-1", version: 1, current_version: 2,
  surface: "lead_magnet", record_id: "mag-1", label: "Cost guide",
  live: true, live_note: "Still downloadable", superseded: true,
  drift: "Carrying v1 while v2 is current.", ...over,
});

function database(data: {
  offers?: unknown[]; versions?: unknown[]; signoffs?: unknown[]; drift?: unknown[]; jobs?: unknown[];
  opportunities?: unknown[]; approvals?: unknown[]; sources?: unknown[]; mainSources?: unknown[];
  failTable?: string;
}) {
  const byTable: Record<string, unknown[]> = {
    service_offers: data.offers ?? [],
    service_offer_versions: data.versions ?? [],
    service_offer_signoffs: data.signoffs ?? [],
    offer_version_drift: data.drift ?? [],
    agent_jobs: data.jobs ?? [],
    market_opportunities: data.opportunities ?? [],
    opportunity_approval_state_v6: data.approvals ?? [],
    secondary_offer_sources_v7: data.sources ?? [],
    main_offer_sources_v7: data.mainSources ?? [],
  };
  // The panel chains select -> eq -> order for some tables and select -> eq for
  // others, so the chain is a thenable rather than having one terminal method:
  // awaiting it at any point yields the rows.
  from.mockImplementation((table: string) => {
    const result = { data: byTable[table] ?? [], error: table === data.failTable ? { message: "Read denied" } : null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      insert: insert.mockResolvedValue({ error: null }),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result)),
    });
    return chain;
  });
}

function show(view: "offers" | "build" = "offers", entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <OfferStudioPanel view={view} />
    </MemoryRouter>,
  );
}

async function selectBaseline() {
  await userEvent.click(await screen.findByRole("radio", { name: "Baseline service" }));
}

async function selectOpportunity() {
  await userEvent.click(await screen.findByRole("radio", { name: "Approved opportunity" }));
}

async function nameService() {
  await userEvent.type(screen.getByRole("textbox", { name: "Business service" }), "Garage conversion");
}

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useParams: () => ({ clientId: "client-1" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
});

describe("the source-first Build path", () => {
  it("creates a main offer as main", async () => {
    database({ offers: [] });
    show("build");
    await selectBaseline();
    await userEvent.type(screen.getByRole("textbox", { name: "Business service" }), "Garage conversion");
    await userEvent.click(screen.getByRole("button", { name: "Create manual draft" }));
    expect(rpc).toHaveBeenCalledWith("create_named_main_offer_v9", {
      p_client_id: "client-1", p_service_name: "Garage conversion",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a secondary offer as secondary", async () => {
    database({ offers: [], opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Unused garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: true }] });
    show("build");
    await selectOpportunity();
    await userEvent.type(screen.getByRole("textbox", { name: "Business service" }), "Garage conversion");
    await userEvent.click(screen.getByRole("button", { name: "Create manual draft" }));
    expect(rpc).toHaveBeenCalledWith("create_named_secondary_offer_v9", {
      p_opportunity_id: "opp-1", p_service_name: "Garage conversion",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("holds secondary actions until an opportunity has current approval", async () => {
    database({ offers: [], opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Unused garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: false }] });
    show("build");
    await selectOpportunity();
    await userEvent.type(screen.getByRole("textbox", { name: "Business service" }), "Garage conversion");
    expect(screen.getByRole("button", { name: "Create manual draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Draft with agent" })).toBeDisabled();
  });

  it("says what to do when there is nothing yet, naming both kinds", async () => {
    database({ offers: [] });
    show();
    expect(await screen.findByText(/Open Build to make a baseline service/)).toBeInTheDocument();
  });

  it("opens a selected source-bound offer for an exact draft version", async () => {
    database({ offers: [offer()] });
    show("build", "/?tab=build&offer=offer-1");
    expect(await screen.findByRole("heading", { name: "New offer version" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Service name" })).toHaveValue("Garage conversion");
    await userEvent.type(screen.getByRole("textbox", { name: "Audience" }), "Homeowners");
    await userEvent.type(screen.getByRole("textbox", { name: "Offer promise" }), "A usable garage gym");
    await userEvent.type(screen.getByRole("textbox", { name: "Dream outcome" }), "A functional home gym");
    await userEvent.type(screen.getByRole("textbox", { name: "How this offer strengthens the outcome" }), "Designed around the home");
    await userEvent.type(screen.getByRole("textbox", { name: "Perceived likelihood of achievement" }), "A measured build plan");
    await userEvent.type(screen.getByRole("textbox", { name: "Proof or mechanism that raises likelihood" }), "Site survey and plan");
    await userEvent.type(screen.getByRole("textbox", { name: "Time delay" }), "Four weeks");
    await userEvent.type(screen.getByRole("textbox", { name: "Steps that reduce delay, one per line" }), "Survey first");
    await userEvent.type(screen.getByRole("textbox", { name: "Effort and sacrifice" }), "One planning call");
    await userEvent.type(screen.getByRole("textbox", { name: "Steps that reduce effort, one per line" }), "We handle planning");
    await userEvent.click(screen.getByRole("button", { name: "Save draft version" }));
    expect(rpc).toHaveBeenCalledWith("create_service_offer_version_v9", expect.objectContaining({
      p_offer_id: "offer-1", p_service_name: "Garage conversion",
      p_audience: "Homeowners", p_promise: "A usable garage gym",
      p_value_equation: expect.objectContaining({ dream_outcome: "A functional home gym",
        delay_reduction_steps: ["Survey first"], effort_reduction_steps: ["We handle planning"] }),
    }));
  });

  it("keeps versions for another offer out of the selected Build editor", async () => {
    database({
      offers: [offer(), offer({ id: "offer-2", service_name: "Roof repair" })],
      versions: [version(), version({ id: "ver-3", offer_id: "offer-2", promise: "A repaired roof" })],
    });
    show("build", "/?tab=build&offer=offer-1");
    expect(await screen.findByRole("heading", { name: "Garage conversion versions" })).toBeInTheDocument();
    expect(screen.getByText("Version 2 · Draft")).toBeInTheDocument();
    expect(screen.queryByText("A repaired roof")).toBeNull();
  });

  it("lets a saved Versions link choose an existing offer", async () => {
    database({ offers: [offer()] });
    show("build", "/?tab=versions");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Continue an existing offer" }), "offer-1");
    expect(await screen.findByRole("heading", { name: "Garage conversion versions" })).toBeInTheDocument();
  });
});

describe("the table", () => {
  it("shows a failed source read as unavailable with a retry", async () => {
    database({ offers: [], failTable: "service_offers" });
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Offers are unavailable: Read denied");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/No offers yet/)).toBeNull();
  });

  it("shows an unsigned latest version in Proposed offers", async () => {
    database({ offers: [offer()], versions: [version()] });
    show();
    const proposed = await screen.findByRole("region", { name: "Proposed offers" });
    expect(within(proposed).getByText("Garage conversion")).toBeInTheDocument();
    expect(within(proposed).getByText("Baseline service")).toBeInTheDocument();
    expect(within(proposed).getByText("Proposed")).toBeInTheDocument();
    expect(within(proposed).getByText("v2")).toBeInTheDocument();
  });

  it("reports a signed-off version as signed off", async () => {
    database({
      offers: [offer()],
      versions: [version()],
      signoffs: [{ offer_version_id: "ver-2", client_id: "client-1" }],
    });
    show();
    const approved = await screen.findByRole("region", { name: "Approved offers" });
    expect(within(approved).getByText("Garage conversion")).toBeInTheDocument();
    expect(within(approved).getByText("Signed off")).toBeInTheDocument();
    expect(within(approved).getByText("v2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Proposed offers" })).queryByText("Garage conversion")).toBeNull();
  });

  it("shows an unbound secondary offer as source unknown", async () => {
    database({ offers: [offer({ id: "offer-2", kind: "secondary", service_name: "Roofers" })] });
    show();
    const proposed = await screen.findByRole("region", { name: "Proposed offers" });
    expect(within(proposed).getByText("Roofers")).toBeInTheDocument();
    expect(within(proposed).getByText("Source unknown")).toBeInTheDocument();
  });

  it("shows the linked opportunity, reviewer and revision action for a signed offer", async () => {
    database({
      offers: [offer({ kind: "secondary" })], versions: [version()],
      signoffs: [{ offer_version_id: "ver-2", approved_by: "reviewer-1", client_id: "client-1" }],
      sources: [{ offer_id: "offer-1", opportunity_id: "opp-1" }],
      opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: true }],
    });
    show();
    const approved = await screen.findByRole("region", { name: "Approved offers" });
    expect(within(approved).getByText("Winter garage gym")).toBeInTheDocument();
    expect(within(approved).getByText("reviewer-1")).toBeInTheDocument();
    expect(within(approved).getByRole("link", { name: "Revise" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/offer-studio?tab=build&offer=offer-1",
    );
  });
});

describe("the question Live use existed to answer", () => {
  it("names a superseded-but-live version on the offer it belongs to", async () => {
    database({ offers: [offer()], versions: [version()], drift: [drift()] });
    show();
    expect(await screen.findByText("1 superseded version still live")).toBeInTheDocument();
  });

  it("leaves the column blank when nothing is drifting", async () => {
    database({ offers: [offer()], versions: [version()] });
    show();
    expect(await screen.findByText("Garage conversion")).toBeInTheDocument();
    expect(screen.queryByText(/superseded version/)).toBeNull();
  });

  it("ignores a superseded version that is not live, and a live one that is current", async () => {
    database({
      offers: [offer()],
      drift: [drift({ live: false }), drift({ offer_version_id: "ver-2", superseded: false })],
    });
    show();
    expect(await screen.findByText("Garage conversion")).toBeInTheDocument();
    expect(screen.queryByText(/superseded version/)).toBeNull();
  });

  it("gives the specifics in the detail, including the surface it is live on", async () => {
    database({ offers: [offer()], versions: [version()], drift: [drift()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    const detail = screen.getByRole("region", { name: "Garage conversion" });
    expect(within(detail).getByText(/lead_magnet/)).toBeInTheDocument();
    expect(within(detail).getByText(/Cost guide/)).toBeInTheDocument();
    expect(within(detail).getByText(/Still downloadable/)).toBeInTheDocument();
  });
});

describe("the detail", () => {
  it("shows the reviewed Strategy snapshot bound to a new main offer", async () => {
    database({ offers: [offer()], mainSources: [{ offer_id: "offer-1", strategy_hash: "a".repeat(64) }] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/bound to reviewed Offer Strategy/)).toBeInTheDocument();
    expect(screen.getByText(/Source: reviewed Offer Strategy snapshot/)).toBeInTheDocument();
  });

  it("labels a historical main offer without a reviewed source", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/legacy main offer has no reviewed Offer Strategy snapshot/)).toBeInTheDocument();
    expect(screen.getByText(/Source review is unverified/)).toBeInTheDocument();
  });

  it("explains where a secondary offer is compiled from", async () => {
    database({ offers: [offer({ kind: "secondary" })] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/compiled from that market opportunity/)).toBeInTheDocument();
  });

  it("says plainly when an offer has no version, rather than showing an empty list", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByText(/No version yet/)).toBeInTheDocument();
  });

  it("links to the version form so nothing from the old tabs is unreachable", async () => {
    database({ offers: [offer()] });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Show Garage conversion" }));
    expect(screen.getByRole("link", { name: "Edit versions and claims" })).toHaveAttribute(
      "href",
      "/clients/client-1/delivery/offer-studio?tab=build&offer=offer-1",
    );
  });
});

describe("compiling an offer instead of writing one", () => {
  it("shows a completed compile and asks for draft review", async () => {
    database({ offers: [], jobs: [{ id: "job-1", status: "completed", terminal: true, error: null }] });
    rpc.mockResolvedValueOnce({ data: "job-1", error: null });
    show("build");
    await selectBaseline();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Review the draft version/);
    expect(from).toHaveBeenCalledWith("agent_jobs");
  });

  it("shows a terminal compile failure instead of leaving Queued on screen", async () => {
    database({ offers: [], jobs: [{ id: "job-2", status: "failed", terminal: true, error: "Version writer refused the draft." }],
      opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Unused garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: true }] });
    rpc.mockResolvedValueOnce({ data: "job-2", error: null });
    show("build");
    await selectOpportunity();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Version writer refused the draft/);
  });

  it("asks the compiler for a main or a secondary offer", async () => {
    database({ offers: [], opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Unused garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: true }] });
    show("build");
    await selectBaseline();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(rpc).toHaveBeenCalledWith("request_named_offer_compile_v9", {
      p_client_id: "client-1", p_kind: "main", p_opportunity_id: null, p_service_name: "Garage conversion",
    });

    await selectOpportunity();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(rpc).toHaveBeenCalledWith("request_named_offer_compile_v9", {
      p_client_id: "client-1", p_kind: "secondary", p_opportunity_id: "opp-1", p_service_name: "Garage conversion",
    });
  });

  it("creates no offer itself: the agent drafts one", async () => {
    // Compiling must not also insert an empty offer row. Two offers from one
    // click is the bug a shared busy flag invites.
    database({ offers: [] });
    show("build");
    await selectBaseline();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(insert).not.toHaveBeenCalled();
  });

  it("says what the database said when it refuses", async () => {
    // The refusals are informative -- no offer strategy yet, or a compile
    // already running -- so they are shown rather than flattened.
    database({ offers: [] });
    rpc.mockResolvedValue({
      error: { message: "This client has no offer strategy yet." },
    });
    show("build");
    await selectBaseline();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("This client has no offer strategy yet.");
  });

  it("confirms what was queued when it works", async () => {
    database({ offers: [], opportunities: [{ id: "opp-1", name: "Winter garage gym", micro_market: "Unused garages" }],
      approvals: [{ opportunity_id: "opp-1", approval_current: true }] });
    show("build");
    await selectOpportunity();
    await nameService();
    await userEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    expect(await screen.findByRole("status"))
      .toHaveTextContent(/drafting a secondary offer from the selected approved opportunity/);
  });
});
