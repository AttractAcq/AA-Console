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

import { BusinessContextPanel } from "./BusinessContextPanel";

const DRAFT = {
  business_overview: "Implant and veneer dentistry in Durban, two chairs, one dentist.",
  ideal_customer: "Somebody whose bridge has failed twice and eats on one side.",
  main_offer: "Full-arch implant work, priced after a written plan assessment.",
  competitors: "Umhlanga Dental Studio, and doing nothing.",
  brand_voice: "Plain, unhurried.",
  proof_testimonials: "",
  current_marketing: "Instagram, weekly.",
  sales_process: "Phone, then a paid assessment.",
  current_revenue: "",
  target_revenue: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b" });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.upsert = () => Promise.resolve({ error: null });
  chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
  from.mockReturnValue(chain);
});

async function openResearcher() {
  render(<BusinessContextPanel />);
  await userEvent.click(await screen.findByRole("button", { name: /Business Input/i }));
  await userEvent.click(screen.getByRole("button", { name: "Generate with AI" }));
}

// Business Input is ten fields and the one a new client stares at blankly.
// Every downstream agent reads it, so thin context makes cautious output
// everywhere and nobody can tell why.
describe("drafting the business context", () => {
  it("researches the client and fills the form", async () => {
    callRuntime.mockResolvedValue({ draft: DRAFT, sources: "Read their homepage." });
    await openResearcher();

    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/business-context/draft", {
        clientId: "3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b",
        notes: "",
      }),
    );
    expect(await screen.findByDisplayValue(DRAFT.business_overview)).toBeInTheDocument();
    expect(screen.getByDisplayValue(DRAFT.competitors)).toBeInTheDocument();
  });

  it("generates without notes, because the website is the source", async () => {
    callRuntime.mockResolvedValue({ draft: DRAFT });
    await openResearcher();
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("sends what the operator knows, which outranks anything found online", async () => {
    callRuntime.mockResolvedValue({ draft: DRAFT });
    await openResearcher();
    await userEvent.type(screen.getByLabelText(/What you know from talking to them/i), "They refuse whitening.");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(callRuntime).toHaveBeenCalledWith("/admin/business-context/draft", {
        clientId: "3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b",
        notes: "They refuse whitening.",
      }),
    );
  });

  it("shows where the draft came from, so it can be checked", async () => {
    // A researched draft nobody can check is one nobody should save.
    callRuntime.mockResolvedValue({ draft: DRAFT, sources: "Read their homepage and treatments page." });
    await openResearcher();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText(/Read their homepage and treatments page/)).toBeInTheDocument();
  });

  it("shows the runtime's refusal and stays open to try again", async () => {
    callRuntime.mockRejectedValue(
      new Error("There is no website on file for this client and nothing typed in the box."),
    );
    await openResearcher();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no website on file/i);
    expect(screen.getByLabelText(/What you know from talking to them/i)).toBeInTheDocument();
  });
});
