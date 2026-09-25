import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, update } = vi.hoisted(() => ({ from: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));

import { TeamCategoryPanel } from "./TeamCategoryPanel";

const member = {
  id: "member-1", name: "Editor 1", initials: "E1", engagement: "contractor", active: true,
  given_name: "", family_name: "", preferred_name: "", legal_name: "", email: "old@example.com",
  phone: "", address_line1: "", address_line2: "", address_city: "", address_region: "",
  address_postal_code: "", address_country: "", company_name: "", tax_id: "", profile_notes: "",
  personal_info: null, contact_info: null,
};

function query(data: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data, error: null }),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockReturnValue({
    ...query([member]),
    update: (value: unknown) => {
      update(value);
      const chain = { eq: () => chain, then: (done: (result: { error: null }) => void) => Promise.resolve({ error: null }).then(done) };
      return chain;
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

const show = () => render(<MemoryRouter><TeamCategoryPanel category="editors" /></MemoryRouter>);

describe("team profile management", () => {
  it("edits the real roster name and contact fields", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    const name = screen.getByLabelText(/Display name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Jordan Smith");
    const email = screen.getByLabelText("Email");
    await userEvent.clear(email);
    await userEvent.type(email, "jordan@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Jordan Smith", email: "jordan@example.com" })));
  });

  it("retires a contractor without deleting history", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Past work and payments will remain"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ active: false }));
  });

  it("does not retire when confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));
    expect(update).not.toHaveBeenCalled();
  });
});
