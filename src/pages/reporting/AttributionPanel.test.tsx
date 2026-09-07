import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, useParams } = vi.hoisted(() => ({ rpc: vi.fn(), useParams: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));

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

function show(f: Record<string, unknown> | null = funnel(), top: unknown[] = [content()]) {
  rpc.mockImplementation((name: string) =>
    Promise.resolve({ data: name === "acquisition_funnel" ? (f ? [f] : []) : top }),
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

describe("ratios that are unknown rather than zero", () => {
  // "No leads yet" and "nothing converted" are different facts, and only one
  // is bad news. Showing 0% for the first is a lie a client would act on.
  it("shows a dash, not 0%, when there are no leads", async () => {
    show(funnel({ leads: 0, sales: 0, lead_to_sale_pct: null, cash_collected: 0 }));
    expect(await screen.findByText("No leads in this window yet.")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows a dash for cost per lead when nothing has been spent", async () => {
    show(funnel({ spend: 0, cost_per_lead: null, return_on_spend: null }));
    await screen.findByText("Cost per lead");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  // Four dashes with no explanation read as "performed badly".
  it("explains once why the spend half is empty, and that revenue does not depend on it", async () => {
    show(funnel({ spend: 0, cost_per_lead: null, return_on_spend: null }));
    expect(await screen.findByText(/Connect Meta under Account/)).toBeInTheDocument();
    expect(screen.getByText(/revenue half above does not depend on it/i)).toBeInTheDocument();
  });

  it("does not explain it away when spend does exist", async () => {
    show();
    await screen.findByText("Return on spend");
    expect(screen.queryByText(/Connect Meta under Account/)).not.toBeInTheDocument();
  });
});

describe("what is attributed", () => {
  // An empty table and a table nobody has sourced look identical otherwise.
  it("says when no lead has recorded where it came from", async () => {
    show(funnel(), [content({ leads: 0, sales: 0, cash_collected: 0 })]);
    expect(await screen.findByText(/No lead has recorded which asset it came from/)).toBeInTheDocument();
  });

  it("counts how many assets have a lead against them", async () => {
    show(funnel(), [content(), content({ asset_ref: "HD-0016", leads: 0 })]);
    expect(await screen.findByText(/1 of 2 assets have a lead attributed/)).toBeInTheDocument();
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
