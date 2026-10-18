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

// The dialog used to say "they will leave the active roster and lose team
// access". Production does not revoke access: migration 127 adds `tm.active` to
// the four client-access functions and is not applied, so a retired member
// keeps every client they were assigned to. Retiring still does real work, so
// the control stays and the wording tells the truth instead.
describe("what retiring actually promises", () => {
  it("does not claim access is lost", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Retire" }));

    const asked = vi.mocked(window.confirm).mock.calls[0]![0] as string;
    expect(asked).not.toMatch(/lose team access/i);
    expect(asked).toMatch(/not revoked yet/i);
    expect(asked).toMatch(/clear their client assignments/i);
    // The part that is true stays: they do come off the roster and briefs stop.
    expect(asked).toMatch(/stop being sent briefs/i);
  });

  it("repeats it on the retired list, for anyone who clicked through", async () => {
    from.mockReturnValue({
      ...query([{ ...member, id: "member-2", name: "Editor 2", active: false }]),
      update: () => {
        const chain = { eq: () => chain, then: (done: (result: { error: null }) => void) => Promise.resolve({ error: null }).then(done) };
        return chain;
      },
    });
    show();

    await userEvent.click(await screen.findByRole("button", { name: /Show retired \(1\)/ }));
    expect(screen.getByText(/does not\s+yet revoke their sign-in/i)).toBeInTheDocument();
  });
});
