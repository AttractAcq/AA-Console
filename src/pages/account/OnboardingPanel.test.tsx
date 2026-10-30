import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, rpc, useParams } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  useParams: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({
  useParams,
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

import { OnboardingPanel } from "./OnboardingPanel";
import type { IntegrationEvidence } from "../../lib/integrationReadiness";

const filters: [string, string, unknown][] = [];

const integration = (provider: "meta" | "instagram", client_id = "client-1"): IntegrationEvidence => ({
  client_id,
  provider,
  credential_secret_id: `${provider}-vault-id`,
  credential_label: provider === "meta" ? "act_123" : "17841400000000000",
  ad_account_id: provider === "meta" ? "act_123" : null,
  status: "connected",
  token_expires_at: null,
  last_checked_at: null,
  ingest_enabled: true,
});

type Tables = {
  client_contact_details?: Record<string, unknown> | null;
  client_business_context?: Record<string, unknown> | null;
  client_brand_profiles?: Record<string, unknown> | null;
  client_integrations?: IntegrationEvidence[];
  client_onboarding_steps?: { step_key: string }[];
};

function show(tables: Tables = {}) {
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "update"]) chain[m] = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters.push([table, column, value]);
      return chain;
    };
    chain.upsert = () => Promise.resolve({ error: null });
    chain.maybeSingle = () =>
      Promise.resolve({ data: (tables as Record<string, unknown>)[table] ?? null, error: null });
    chain.then = (r: (v: unknown) => unknown) =>
      Promise.resolve({ data: (tables as Record<string, unknown>)[table] ?? [], error: null }).then(r);
    return chain;
  });
  return render(<OnboardingPanel />);
}

const COMPLETE: Tables = {
  client_contact_details: { primary_contact: "Kyle", website: "https://x.co.za" },
  client_business_context: {
    business_overview: "a",
    ideal_customer: "b",
    main_offer: "c",
    competitors: "d",
  },
  client_brand_profiles: { colour_primary: "#142B23", imagery_style: "Documentary" },
  client_integrations: [integration("meta"), integration("instagram")],
  client_onboarding_steps: [{ step_key: "onboarding_call" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  filters.length = 0;
  useParams.mockReturnValue({ clientId: "client-1" });
  rpc.mockResolvedValue({ data: null, error: null });
});

// Onboarding used to be three checkboxes somebody ticked by hand. Nothing was
// collected, and a client could be fully "onboarded" with an empty business
// context — which is how agents end up writing cautious output nobody can
// account for.
describe("progress is derived from the data, never stored", () => {
  it("shows nothing done on a client nobody has touched", async () => {
    show();
    expect(await screen.findByText("0 of 5 complete")).toBeInTheDocument();
  });

  it("does not call provider access done from two stored rows", async () => {
    show(COMPLETE);
    expect(await screen.findByText("4 of 5 complete")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Provider activation dry run" })).toHaveTextContent("Current result: Unknown");
    expect(screen.queryByText("5 of 5 complete")).not.toBeInTheDocument();
    expect(filters).toContainEqual(["client_integrations", "client_id", "client-1"]);
  });

  it("refreshes the dry run with reads only", async () => {
    show(COMPLETE);
    await screen.findByRole("region", { name: "Provider activation dry run" });
    const before = from.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh readiness" }));
    await waitFor(() => expect(from.mock.calls.length).toBeGreaterThan(before));
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Provider activation dry run" })).toHaveTextContent("Current result: Unknown");
  });

  it("counts a step somebody filled in from its own panel", async () => {
    // Nothing tells onboarding about it. That is the point of reading the
    // destination table rather than storing a claim.
    show({ client_brand_profiles: { colour_primary: "#000", imagery_style: "Studio" } });
    expect(await screen.findByText("1 of 5 complete")).toBeInTheDocument();
  });
});

describe("a half-finished step keeps its work", () => {
  it("names exactly what is still needed", async () => {
    show({ client_contact_details: { website: "https://x.co.za" } });
    expect(await screen.findByText(/Still needed: primary contact/)).toBeInTheDocument();
  });

  it("offers to continue rather than start again", async () => {
    show({ client_contact_details: { website: "https://x.co.za" } });
    expect(await screen.findByRole("button", { name: "Continue Contact & identity" })).toBeInTheDocument();
  });

  it("points at the half-finished step before an untouched one", async () => {
    show({ client_brand_profiles: { colour_primary: "#000" } });
    expect(await screen.findByText(/Next:/)).toHaveTextContent("Brand & design");
  });
});

describe("onboarding collects, the panel keeps", () => {
  it("says where each step's data lives, so it can be edited later", async () => {
    show(COMPLETE);
    expect(await screen.findByRole("link", { name: "Contact & Identity" })).toHaveAttribute(
      "href",
      "/clients/client-1/account/contact",
    );
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/clients/client-1/account/integrations",
    );
    // Business Context is under delivery/, not account/. The first version
    // linked to /account/business-context, which is not a route.
    expect(
      screen.getByRole("link", { name: "Intelligence → Business Context" }),
    ).toHaveAttribute("href", "/clients/client-1/delivery/intelligence?tab=business-context");
  });

  it("writes a step straight into the table that owns it", async () => {
    // Not a copy: this is the same write the step's own panel makes.
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Fill in Contact & identity" }));
    await userEvent.type(screen.getByLabelText(/Primary contact/), "Kyle");
    await userEvent.type(screen.getByLabelText(/^Website/), "https://x.co.za");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(from).toHaveBeenCalledWith("client_contact_details"));
  });
});

describe("when the database cannot answer", () => {
  it("says so rather than reporting an empty client", async () => {
    // Supabase reports failure in the result, not by throwing. Without
    // checking it, a broken query reads as "nothing on file" and the panel
    // claims a client has completed none of onboarding.
    from.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: { message: "column missing" } });
      chain.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: "column missing" } }).then(r);
      return chain;
    });
    render(<OnboardingPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/column missing/);
    expect(screen.queryByText(/0 of 5 complete/)).not.toBeInTheDocument();
  });

  it("refuses a cross-client integration response instead of displaying its metadata", async () => {
    show({ client_integrations: [integration("meta", "client-2")] });
    expect(await screen.findByRole("alert")).toHaveTextContent(/another client's data/);
    expect(screen.queryByRole("region", { name: "Provider activation dry run" })).not.toBeInTheDocument();
  });

  it("does not render the previous client's readiness while the next client loads", async () => {
    const view = show(COMPLETE);
    expect(await screen.findByText("4 of 5 complete")).toBeInTheDocument();
    useParams.mockReturnValue({ clientId: "client-2" });
    view.rerender(<OnboardingPanel />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Provider activation dry run" })).not.toBeInTheDocument();
  });

  it("shows an unhealthy integration as blocked and never starts an external action", async () => {
    show({ client_integrations: [integration("meta"), { ...integration("instagram"), status: "revoked" }] });
    const region = await screen.findByRole("region", { name: "Provider activation dry run" });
    expect(region).toHaveTextContent("Current result: Blocked");
    expect(region).toHaveTextContent("instagram status is revoked");
    expect(region).toHaveTextContent("Required scopes: Unknown");
    expect(rpc).not.toHaveBeenCalled();
  });
});
