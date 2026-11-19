import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams, insert } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
  insert: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams,
  // Link renders as an anchor so tests can still find navigation by role.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

import { ClientEconomicsPanel } from "./ClientEconomicsPanel";

type Eco = Record<string, unknown>;

const healthy = (over: Eco = {}): Eco => ({
  spend: 10000,
  leads: 4,
  qualified_leads: 4,
  appointments: 3,
  customers: 2,
  revenue: 40000,
  cash_collected: 20000,
  cpl: 2500,
  cpql: 2500,
  cpa: 3333.33,
  cac: 5000,
  roas: 4,
  cash_roas: 2,
  revenue_per_lead: 10000,
  avg_customer_value: 20000,
  currency: "ZAR",
  mixed_currency: false,
  ...over,
});

/** Spend recorded, nothing converted yet — production's real state today. */
const spendOnly = (): Eco =>
  healthy({
    leads: 0, qualified_leads: 0, appointments: 0, customers: 0,
    revenue: 0, cash_collected: 0,
    cpl: null, cpql: null, cpa: null, cac: null,
    roas: 0, cash_roas: 0, revenue_per_lead: null, avg_customer_value: null,
  });

const channels = [
  { channel: "instagram", spend: 6000, leads: 2, customers: 1, revenue: 30000, cash_collected: 20000, cpl: 3000, cac: 6000, roas: 5 },
  { channel: "(unattributed)", spend: 1000, leads: 1, customers: 0, revenue: 0, cash_collected: 0, cpl: 1000, cac: null, roas: 0 },
];

const campaignRows = [
  { campaign_id: "c1", campaign_ref: "HD-C002", spend: 6000, leads: 2, customers: 1, revenue: 30000, cash_collected: 20000, cpl: 3000, cac: 6000, roas: 5 },
];

function show(totals: Eco | null = healthy(), ch: Eco[] = channels, cp: Eco[] = campaignRows) {
  rpc.mockImplementation((name: string) => {
    if (name === "client_economics") return Promise.resolve({ data: totals ? [totals] : [], error: null });
    if (name === "client_economics_by_channel") return Promise.resolve({ data: ch, error: null });
    return Promise.resolve({ data: cp, error: null });
  });
  insert.mockResolvedValue({ error: null });
  from.mockImplementation(() => {
    const chain = {
      select: () => chain,
      eq: () => Promise.resolve({ data: [{ id: "c1", campaign_ref: "HD-C002" }] }),
      insert,
    };
    return chain;
  });
  return render(<ClientEconomicsPanel />);
}

const figure = (label: string) =>
  screen.getByRole("heading", { name: label }).closest("section") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("headline economics", () => {
  it("shows spend in its currency without assigning that currency to lead revenue", async () => {
    show();
    expect(await screen.findByText("R10,000")).toBeInTheDocument();
    expect(within(figure("Revenue")).getByText("40,000")).toBeInTheDocument();
    expect(within(figure("ROAS")).getByText("—")).toBeInTheDocument();
    expect(within(figure("Cash ROAS")).getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("4.00×")).not.toBeInTheDocument();
    expect(screen.queryByText("2.00×")).not.toBeInTheDocument();
    expect(screen.getByText(/Lead money totals require one recorded currency/)).toBeInTheDocument();
    // R5,000 is CAC in the headline and also the Customers cost in the funnel
    // table below — both are correct, so scope to the headline panel.
    expect(within(figure("CAC")).getByText("R5,000")).toBeInTheDocument();
  });

  it("says the window is a cohort, not a revenue period", async () => {
    // Asserting on "Cohort economics" specifically: /leads acquired in this
    // window/ also matches the Revenue card's hint, so it passed even with the
    // banner deleted.
    show();
    expect(await screen.findByText(/^Cohort economics:/)).toBeInTheDocument();
  });
});

describe("when there is spend but nothing has converted", () => {
  it("shows the spend as a real number", async () => {
    show(spendOnly());
    expect(await screen.findByText("R10,000")).toBeInTheDocument();
  });

  it("refuses to print 0.00× ROAS, and says why", async () => {
    // The database returns a mathematically correct 0.00 here. Printing it
    // would read as "this failed" rather than "nothing has landed yet".
    show(spendOnly());
    await screen.findByText("R10,000");
    expect(screen.queryByText("0.00×")).not.toBeInTheDocument();
    expect(screen.getAllByText(/no revenue from this cohort yet/i).length).toBeGreaterThan(0);
  });

  it("refuses CAC rather than showing R0", async () => {
    show(spendOnly());
    await screen.findByText("R10,000");
    // Scoped to the headline: a breakdown table may legitimately show R0
    // revenue for a bucket that really earned nothing.
    const cac = within(figure("CAC"));
    expect(cac.getByText("—")).toBeInTheDocument();
    expect(cac.queryByText("R0")).not.toBeInTheDocument();
    expect(screen.getAllByText(/no customers in this cohort yet/i).length).toBeGreaterThan(0);
  });
});

describe("funnel economics", () => {
  it("lists each stage with its cost", async () => {
    show();
    const table = (await screen.findByText("Leads acquired")).closest("table") as HTMLElement;
    const rows = within(table);
    expect(rows.getByText("Leads acquired")).toBeInTheDocument();
    expect(rows.getByText("Qualified")).toBeInTheDocument();
    expect(rows.getByText("Appointments")).toBeInTheDocument();
    expect(rows.getByText("Customers")).toBeInTheDocument();
  });

  it("states that counts are by furthest stage reached", async () => {
    // Without this the reader assumes current stage, and the cost-per-stage
    // figures look wrong for any lead that progressed.
    show();
    expect(await screen.findByText(/furthest stage each lead reached/i)).toBeInTheDocument();
  });
});

describe("breakdowns", () => {
  it("shows unattributed spend as its own bucket rather than hiding it", async () => {
    show();
    expect(await screen.findByText("(unattributed)")).toBeInTheDocument();
  });

  it("does not print a ROAS for any bucket while lead revenue currency is unknown", async () => {
    show();
    await screen.findByText("(unattributed)");
    const table = screen.getByText("(unattributed)").closest("table") as HTMLElement;
    expect(within(table).queryByText("5.00×")).not.toBeInTheDocument();
    expect(within(table).getByText("30,000")).toBeInTheDocument();
    expect(within(table).queryByText("R30,000")).not.toBeInTheDocument();
    expect(within(table).queryByText("0.00×")).not.toBeInTheDocument();
  });
});

describe("mixed currency", () => {
  it("refuses the ratios and says so loudly", async () => {
    show(healthy({ mixed_currency: true, currency: null, roas: null, cash_roas: null, cac: null, cpl: null }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/mixes more than one currency/i);
  });

  it("does not render a missing lead currency total as zero or NaN", async () => {
    show(healthy({ revenue: null, cash_collected: null, roas: null, cash_roas: null }),
      [{ ...channels[0], revenue: null, cash_collected: null, roas: null }],
      [{ ...campaignRows[0], revenue: null, cash_collected: null, roas: null }]);
    await screen.findByText("R10,000");
    expect(within(figure("Revenue")).getByText(/currency coverage is incomplete/i)).toBeInTheDocument();
    expect(within(figure("Cash collected")).getByText(/currency coverage is incomplete/i)).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });
});

describe("date window", () => {
  it("defaults to last 30 days and re-queries when the window changes", async () => {
    show();
    await screen.findByText("R10,000");
    const first = rpc.mock.calls.filter((c) => c[0] === "client_economics").length;

    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    const after = rpc.mock.calls.filter((c) => c[0] === "client_economics").length;
    expect(after).toBeGreaterThan(first);

    // Both dates move together — spend and cohort always share one window.
    const last = rpc.mock.calls.filter((c) => c[0] === "client_economics").at(-1)?.[1] as {
      p_since: string; p_until: string;
    };
    expect(last.p_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last.p_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last.p_since < last.p_until).toBe(true);
  });
});

describe("recording spend", () => {
  it("writes a manual row against this client", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: /record spend/i }));
    await userEvent.type(screen.getByLabelText(/amount/i), "2500");
    await userEvent.type(screen.getByLabelText(/date spent/i), "2026-09-10");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "client-1", amount: 2500, source: "manual" }),
    );
  });
});
