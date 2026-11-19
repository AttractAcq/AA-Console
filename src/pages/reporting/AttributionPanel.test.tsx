import { createElement } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, useParams } = vi.hoisted(() => ({ rpc: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc } }));
vi.mock("./BusinessProfileCoverage", () => ({ BusinessProfileCoverage: () => null }));
vi.mock("react-router-dom", () => ({
  useParams,
  // Link renders as an anchor so tests can still find navigation by role.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

import { AttributionPanel } from "./AttributionPanel";

const funnel = (over: Record<string, unknown> = {}) => ({
  leads: 12, conversations: 7, appointments: 4, sales: 2, lost: 1,
  pipeline_value: 80000, sale_value: 60000, cash_collected: 45000, spend: 9000,
  lead_to_sale_pct: 16.7, cost_per_lead: 750, return_on_spend: 5,
  ...over,
});

const content = (over: Record<string, unknown> = {}) => ({
  asset_ref: "HD-0015", asset_title: "Show Me The Ordinary One",
  hook: "The photo nobody shows you", idea_title: "Show the ordinary one",
  content_territory: "Proof in the order",
  leads: 6, sales: 2, cash_collected: 45000, spend: 9000, impressions: 41000,
  ...over,
});

const coverage = (over: Record<string, unknown> = {}) => ({
  lead_rows: 12, sourced_leads: 6, consented_leads: 5,
  spend_rows: 3, spend_currencies: 1, spend_currency: "ZAR",
  latest_spend_date: "2026-11-15", paid_metric_days: 4,
  latest_paid_metric_date: "2026-11-15", latest_meta_read_at: null,
  latest_google_read_at: null, ...over,
});

function show(f: Record<string, unknown> | null = funnel(), top: unknown[] = [content()],
  c: Record<string, unknown> = coverage(), journeys: unknown[] = []) {
  rpc.mockImplementation((name: string) =>
    Promise.resolve({ data: name === "acquisition_funnel" ? (f ? [f] : [])
      : name === "acquisition_coverage_v8" ? [c]
        : name === "lead_journey_trace_v10" ? journeys : top, error: null }),
  );
  return render(<AttributionPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("the chain", () => {
  it("shows the funnel in the order it happens", async () => {
    show();
    // Scoped: "Leads" is also a column header in the table below.
    const chain = within(
      (await screen.findByRole("heading", { name: "The chain" })).parentElement as HTMLElement,
    );
    for (const label of ["Leads", "Conversations", "Appointments", "Sales"]) {
      expect(chain.getByText(label)).toBeInTheDocument();
    }
  });

  it("traces revenue back to the hook and the idea behind it", async () => {
    show();
    expect(await screen.findByText("The photo nobody shows you")).toBeInTheDocument();
    expect(screen.getByText("Show the ordinary one")).toBeInTheDocument();
  });
});

describe("client boundary", () => {
  function response(name: string, clientId: string) {
    return { data: name === "acquisition_funnel" ? [funnel()]
      : name === "acquisition_coverage_v8" ? [coverage()]
        : name === "lead_journey_trace_v10" ? []
          : [content({ hook: `Hook for ${clientId}` })], error: null };
  }

  it("clears the previous client's figures before the next read completes", async () => {
    let releaseNext!: () => void;
    const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
    rpc.mockImplementation((name: string, args: { p_client_id: string }) =>
      args.p_client_id === "client-2"
        ? nextGate.then(() => response(name, args.p_client_id))
        : Promise.resolve(response(name, args.p_client_id)));
    const view = render(<AttributionPanel />);
    expect(await screen.findByText("Hook for client-1")).toBeInTheDocument();
    useParams.mockReturnValue({ clientId: "client-2" });
    view.rerender(<AttributionPanel />);
    expect(screen.queryByText("Hook for client-1")).not.toBeInTheDocument();
    expect(screen.getByText("Loading attribution…")).toBeInTheDocument();
    await act(async () => { releaseNext(); });
    expect(await screen.findByText("Hook for client-2")).toBeInTheDocument();
  });

  it("ignores an old client's response after the new client has loaded", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    rpc.mockImplementation((name: string, args: { p_client_id: string }) =>
      args.p_client_id === "client-1"
        ? oldGate.then(() => response(name, args.p_client_id))
        : Promise.resolve(response(name, args.p_client_id)));
    const view = render(<AttributionPanel />);
    useParams.mockReturnValue({ clientId: "client-2" });
    view.rerender(<AttributionPanel />);
    expect(await screen.findByText("Hook for client-2")).toBeInTheDocument();
    await act(async () => { releaseOld(); });
    await waitFor(() => expect(screen.getByText("Hook for client-2")).toBeInTheDocument());
    expect(screen.queryByText("Hook for client-1")).not.toBeInTheDocument();
  });
});

describe("recorded lead journeys", () => {
  it("shows the exact capture route while keeping its causal meaning limited", async () => {
    show(funnel(), [content()], coverage(), [{
      lead_id: "12345678-1111-4111-8111-111111111111",
      lead_created_at: "2026-11-15T12:00:00Z", lead_stage: "new",
      source_channel: "paid_search", campaign_id: null, campaign_name: null,
      campaign_mode: null, opportunity_ids: [], offer_version_id: null,
      asset_id: null, asset_title: null, page_id: null, page_title: null,
      sales_agent_id: null, sale_value: null, cash_collected: null,
      outcome_events: 0, route_package_ids: ["87654321-1111-4111-8111-111111111111"],
      capture_submissions: 1, unknown_route_submissions: 0, archived_at: null,
    }]);
    expect(await screen.findByText(/route 87654321/)).toHaveAttribute("title", "87654321-1111-4111-8111-111111111111");
    expect(screen.getByText(/capture doors, not which route caused a sale/)).toBeInTheDocument();
  });

  it("keeps missing source links unknown while showing recorded cash and outcome evidence", async () => {
    show(funnel(), [content()], coverage(), [{
      lead_id: "12345678-1111-4111-8111-111111111111",
      lead_created_at: "2026-11-15T12:00:00Z", lead_stage: "cash",
      source_channel: "organic", campaign_id: null, campaign_name: null,
      campaign_mode: null, opportunity_ids: [], offer_version_id: null,
      asset_id: null, asset_title: null, page_id: null, page_title: null,
      sales_agent_id: null, sale_value: 12000, cash_collected: 9000,
      outcome_events: 1,
      route_package_ids: [], capture_submissions: 0, unknown_route_submissions: 0,
      archived_at: null,
    }]);
    const journeys = within((await screen.findByRole("heading", { name: "Recorded lead journeys" })).parentElement as HTMLElement);
    expect(journeys.getByText(/12345678/)).toBeInTheDocument();
    expect(journeys.getByText(/opportunity unknown/)).toBeInTheDocument();
    expect(journeys.getByText(/asset unknown/)).toBeInTheDocument();
    expect(journeys.getByText("cash · 1 outcome event")).toBeInTheDocument();
    expect(journeys.getByText("12,000 / 9,000")).toBeInTheDocument();
  });

  it("labels an archived lead snapshot separately from live funnel totals", async () => {
    show(funnel(), [content()], coverage(), [{
      lead_id: "12345678-1111-4111-8111-111111111111",
      lead_created_at: "2026-11-15T12:00:00Z", lead_stage: "shown",
      source_channel: "organic", campaign_id: null, campaign_name: null,
      campaign_mode: null, opportunity_ids: [], offer_version_id: null,
      asset_id: null, asset_title: null, page_id: null, page_title: null,
      sales_agent_id: null, sale_value: null, cash_collected: null,
      outcome_events: 0, route_package_ids: [], capture_submissions: 0,
      unknown_route_submissions: 0, archived_at: "2026-11-16T12:00:00Z",
    }]);
    const journeys = within((await screen.findByRole("heading", { name: "Recorded lead journeys" })).parentElement as HTMLElement);
    expect(journeys.getByText(/Archived \d/)).toBeInTheDocument();
    expect(journeys.getByText(/excluded from the live funnel totals/)).toBeInTheDocument();
  });
});

describe("ratios that are unknown rather than zero", () => {
  // "No leads yet" and "nothing converted" are different facts, and only one
  // is bad news. Showing 0% for the first is a lie a client would act on.
  it("shows a dash, not 0%, when there are no leads", async () => {
    show(funnel({ leads: 0, sales: 0, lead_to_sale_pct: null, cash_collected: 0 }));
    expect(await screen.findByText("No leads in this window yet.")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows a dash for cost per lead when nothing has been spent", async () => {
    show(funnel({ spend: 0, cost_per_lead: null, return_on_spend: null }),
      [content()], coverage({ spend_rows: 0, spend_currencies: 0, spend_currency: null }));
    await screen.findByText("Cost per lead");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  // Four dashes with no explanation read as "performed badly".
  it("explains once why the spend half is empty, and that revenue does not depend on it", async () => {
    show(funnel({ spend: 0, cost_per_lead: null, return_on_spend: null }),
      [content()], coverage({ spend_rows: 0, spend_currencies: 0, spend_currency: null }));
    expect(await screen.findByText(/Connect Meta or Google Ads under Account/)).toBeInTheDocument();
    expect(screen.getByText(/recorded revenue above does not depend on an ads connection/i)).toBeInTheDocument();
  });

  it("does not explain it away when spend does exist", async () => {
    show();
    await screen.findByText("Return on spend");
    expect(screen.queryByText(/Connect Meta or Google Ads under Account/)).not.toBeInTheDocument();
  });

  it("hides cost and return ratios when spend uses mixed currencies", async () => {
    show(funnel(), [content()], coverage({ spend_currencies: 2, spend_currency: null }));
    expect(await screen.findByText(/Spend entries use more than one currency/)).toBeInTheDocument();
    const cost = screen.getByText("Cost per lead").parentElement as HTMLElement;
    expect(within(cost).getByText("—")).toBeInTheDocument();
    const roas = screen.getByText("Return on spend").parentElement as HTMLElement;
    expect(within(roas).getByText("—")).toBeInTheDocument();
  });

  it("shows spend-only cost in its currency but holds return without lead cash currency", async () => {
    show(funnel({ cost_per_lead: 1500, return_on_spend: 5 }), [content()],
      coverage({ spend_rows: 1, spend_currencies: 1, spend_currency: "USD" }));
    expect(await screen.findByText(/does not expose lead cash currency coverage/)).toBeInTheDocument();
    expect(within(screen.getByText("Cost per lead").parentElement as HTMLElement).getByText("USD 1,500")).toBeInTheDocument();
    expect(within(screen.getByText("Return on spend").parentElement as HTMLElement).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByText("Cash collected · currency not shown").parentElement as HTMLElement).getByText("45,000")).toBeInTheDocument();
    expect(screen.queryByText("5×")).not.toBeInTheDocument();
  });

  it("shows a failed read as an error rather than zero cash", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "acquisition_funnel"
      ? { data: null, error: { message: "Funnel read failed" } }
      : { data: [], error: null }));
    render(<AttributionPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Funnel read failed");
    expect(screen.queryByText("R0")).not.toBeInTheDocument();
  });
});

describe("what is attributed", () => {
  it("labels the content ranking as all time while funnel windows change", async () => {
    show();
    expect(await screen.findByRole("heading", { name: /What produced the revenue · all time/ })).toBeInTheDocument();
  });
  // An empty table and a table nobody has sourced look identical otherwise.
  it("says when no lead has recorded where it came from", async () => {
    show(funnel(), [content({ leads: 0, sales: 0, cash_collected: 0 })]);
    expect(await screen.findByText(/No lead has recorded which asset it came from/)).toBeInTheDocument();
  });

  it("counts how many assets have a lead against them", async () => {
    show(funnel(), [content(), content({ asset_ref: "HD-0016", leads: 0 })]);
    expect(await screen.findByText(/1 of 2 shown assets have a lead attributed/)).toBeInTheDocument();
  });

  it("says plainly when there are no assets at all", async () => {
    show(funnel(), []);
    expect(await screen.findByText(/No assets yet, so nothing to attribute revenue to/)).toBeInTheDocument();
  });
});

describe("the period", () => {
  it("re-asks the database when the window changes", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("heading", { name: "The chain" });
    rpc.mockClear();
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(rpc).toHaveBeenCalledWith("acquisition_funnel", { p_client_id: "client-1", p_days: 7 });
  });
});
