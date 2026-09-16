import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tables, updates } = vi.hoisted(() => ({
  tables: new Map<string, unknown>(),
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
}));

vi.mock("../../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const result = tables.get(table) ?? { data: table === "team_members" ? null : [], count: 0 };
          return Object.assign(Promise.resolve(result), {
            maybeSingle: () => Promise.resolve(tables.get(table) ?? { data: null }),
          });
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          updates.push({ table, patch });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));
vi.mock("react-router-dom", () => ({
  useParams: () => ({ memberId: "member-1", category: "editors" }),
}));

import { OverviewSection } from "./OverviewSection";

const STRUCTURED = {
  given_name: "Naledi",
  family_name: "Khumalo",
  preferred_name: null,
  legal_name: null,
  email: "naledi@harbourdental.co.za",
  phone: "+27 21 555 0134",
  address_line1: "12 Bay Road",
  address_line2: null,
  address_city: "Cape Town",
  address_region: "Western Cape",
  address_postal_code: "8001",
  address_country: "South Africa",
  company_name: "Harbour Talent",
  tax_id: "ZA4123456789",
  profile_notes: null,
  personal_info: "Naledi Khumalo",
  contact_info: "naledi@harbourdental.co.za",
};

function show(row: Record<string, unknown> | null = STRUCTURED) {
  tables.set("team_members", { data: row });
  tables.set("contract_payments", { data: [{ compensation: 1200 }, { compensation: 300 }] });
  tables.set("client_media_assets", { data: null, count: 4 });
  return render(<OverviewSection />);
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  updates.length = 0;
});

describe("OverviewSection — structured profile", () => {
  it("keeps compensation and output as calculated totals", async () => {
    show();
    expect(await screen.findByText("1500.00")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("shows named personal and contact fields, not a JSON dump", async () => {
    show();
    expect(await screen.findByText("Naledi")).toBeInTheDocument();
    expect(screen.getByText("Khumalo")).toBeInTheDocument();
    expect(screen.getByText("Harbour Talent")).toBeInTheDocument();
    expect(screen.getByText("ZA4123456789")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "naledi@harbourdental.co.za" })).toHaveAttribute(
      "href",
      "mailto:naledi@harbourdental.co.za",
    );
    expect(screen.getByRole("link", { name: "+27 21 555 0134" })).toHaveAttribute("href", "tel:+27215550134");
    expect(screen.getByText(/12 Bay Road/)).toBeInTheDocument();
    expect(screen.getByText(/Cape Town Western Cape 8001/)).toBeInTheDocument();
    expect(screen.queryByText(/"given_name"/)).not.toBeInTheDocument();
  });

  it("maps a leftover contact blob into the email field so existing data is not blanked", async () => {
    show({
      given_name: null,
      family_name: null,
      preferred_name: null,
      legal_name: null,
      email: null,
      phone: null,
      address_line1: null,
      address_line2: null,
      address_city: null,
      address_region: null,
      address_postal_code: null,
      address_country: null,
      company_name: null,
      tax_id: null,
      profile_notes: null,
      personal_info: null,
      contact_info: "Alexander.thomas2401@gmail.com",
    });
    expect(await screen.findByRole("link", { name: "Alexander.thomas2401@gmail.com" })).toBeInTheDocument();
  });

  it("opens a structured form, not the old textareas", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Naledi");
    await user.click(screen.getByRole("button", { name: "Add Information" }));
    expect(screen.getByText(/Total Compensation and Total Output are calculated/)).toBeInTheDocument();
    expect(screen.getByLabelText("Given name")).toHaveValue("Naledi");
    expect(screen.getByLabelText("Surname")).toHaveValue("Khumalo");
    expect(screen.getByLabelText("Email")).toHaveValue("naledi@harbourdental.co.za");
    expect(screen.getByLabelText("Phone")).toHaveValue("+27 21 555 0134");
    expect(screen.getByLabelText("Street address")).toHaveValue("12 Bay Road");
    expect(screen.getByLabelText("City")).toHaveValue("Cape Town");
    expect(screen.getByLabelText("Region / state")).toHaveValue("Western Cape");
    expect(screen.getByLabelText("Postal code")).toHaveValue("8001");
    expect(screen.getByLabelText("Country")).toHaveValue("South Africa");
    expect(screen.getByLabelText("Company")).toHaveValue("Harbour Talent");
    expect(screen.getByLabelText("Tax ID / VAT")).toHaveValue("ZA4123456789");
    expect(screen.queryByLabelText("Personal information")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Contact information")).not.toBeInTheDocument();
  });

  it("saves structured columns and leaves the legacy blobs untouched", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Naledi");
    await user.click(screen.getByRole("button", { name: "Add Information" }));
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "naledi.k@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.table).toBe("team_members");
    expect(updates[0]?.patch).toMatchObject({
      given_name: "Naledi",
      family_name: "Khumalo",
      email: "naledi.k@example.com",
      phone: "+27 21 555 0134",
    });
    expect(updates[0]?.patch).not.toHaveProperty("personal_info");
    expect(updates[0]?.patch).not.toHaveProperty("contact_info");
    expect(updates[0]?.patch).not.toHaveProperty("compensation");
  });
});
