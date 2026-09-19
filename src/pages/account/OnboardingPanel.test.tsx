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

type Tables = {
  client_contact_details?: Record<string, unknown> | null;
  client_business_context?: Record<string, unknown> | null;
  client_brand_profiles?: Record<string, unknown> | null;
  client_integrations?: { provider: string }[];
  client_onboarding_steps?: { step_key: string }[];
};

function show(tables: Tables = {}) {
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "update"]) chain[m] = () => chain;
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
  client_integrations: [{ provider: "meta" }, { provider: "instagram" }],
  client_onboarding_steps: [{ step_key: "onboarding_call" }],
};

beforeEach(() => {
  vi.clearAllMocks();
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

  it("shows everything done when the app has what it needs", async () => {
    show(COMPLETE);
    expect(await screen.findByText("5 of 5 complete")).toBeInTheDocument();
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
});
