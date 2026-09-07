import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tables, signPaths, useParams } = vi.hoisted(() => ({
  tables: new Map<string, unknown>(),
  signPaths: vi.fn(),
  useParams: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(tables.get(table) ?? { data: null }) }),
      }),
    }),
    storage: { from: () => ({ upload: vi.fn() }) },
  },
}));
vi.mock("../../lib/media", () => ({ signPaths }));
vi.mock("react-router-dom", () => ({ useParams }));

import { ContactPanel } from "./ContactPanel";

const FULL = {
  client_id: "client-1",
  primary_contact: "Dr Naledi Khumalo",
  role_title: "Practice owner",
  email: "naledi@harbourdental.co.za",
  phone: "+27 21 555 0134",
  whatsapp: "+27 82 555 0134",
  website: "harbourdental.co.za",
  instagram: "@harbourdental",
  facebook: "harbourdental",
  address: "12 Bay Road\nCape Town",
  logo_path: "client-1/identity/logo.png",
  notes: null,
};

function show(row: Record<string, unknown> | null = FULL, logo = "https://signed/logo.png") {
  tables.set("client_contact_details", { data: row });
  tables.set("clients", { data: { name: "Harbour Dental" } });
  signPaths.mockResolvedValue(new Map(row?.logo_path ? [[row.logo_path as string, logo]] : []));
  return render(<ContactPanel />);
}

const publicPanel = () =>
  within(screen.getByRole("heading", { name: "Public details" }).closest("section") as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("ContactPanel — identity header", () => {
  it("leads with the client, not with a form", async () => {
    show();
    expect(await screen.findByRole("heading", { name: "Harbour Dental" })).toBeInTheDocument();
    expect(screen.getByText(/Dr Naledi Khumalo · Practice owner/)).toBeInTheDocument();
  });

  it("shows the logo that will actually be composited", async () => {
    show();
    expect(await screen.findByAltText("Harbour Dental logo")).toHaveAttribute(
      "src",
      "https://signed/logo.png",
    );
  });

  it("says the client is creative-ready when it has details and a mark", async () => {
    show();
    expect(await screen.findByText(/Creative-ready/)).toBeInTheDocument();
  });

  // Each gap has a different consequence on the finished advert, so they
  // must not collapse into one generic "incomplete".
  it("names the missing logo specifically", async () => {
    show({ ...FULL, logo_path: null }, "");
    expect(await screen.findByText(/No logo — creative leaves the mark off/)).toBeInTheDocument();
  });

  it("names missing public details specifically", async () => {
    show({ client_id: "c", primary_contact: "A", logo_path: "client-1/identity/logo.png" });
    expect(await screen.findByText(/No public details/)).toBeInTheDocument();
  });

  it("warns plainly when creative would carry no identity at all", async () => {
    show(null, "");
    expect(await screen.findByText(/no identity at all/i)).toBeInTheDocument();
  });
});

describe("ContactPanel — what creative will print", () => {
  // The reason this page exists. A blank field is not an empty row to tidy
  // away; it is the reason a corner of the next advert will be empty.
  it("shows an unset public detail rather than hiding it", async () => {
    show({ ...FULL, whatsapp: null, facebook: null });
    await screen.findByRole("heading", { name: "Harbour Dental" });
    expect(publicPanel().getByText("WhatsApp")).toBeInTheDocument();
    expect(publicPanel().getAllByText("Not set")).toHaveLength(2);
  });

  it("counts how many of the public details are set", async () => {
    show({ ...FULL, whatsapp: null });
    expect(await screen.findByText("5/6 set")).toBeInTheDocument();
  });

  it("separates internal contact from what gets published", async () => {
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    expect(screen.getByText(/Never rendered onto anything/i)).toBeInTheDocument();
    expect(publicPanel().queryByText("naledi@harbourdental.co.za")).not.toBeInTheDocument();
  });
});

describe("ContactPanel — the values are actionable", () => {
  it("makes the phone dialable, stripping formatting from the href only", async () => {
    show();
    const link = await screen.findByRole("link", { name: "+27 21 555 0134" });
    expect(link).toHaveAttribute("href", "tel:+27215550134");
  });

  it("links WhatsApp to a wa.me conversation", async () => {
    show();
    expect(await screen.findByRole("link", { name: /\+27 82 555 0134/ })).toHaveAttribute(
      "href",
      "https://wa.me/27825550134",
    );
  });

  // Operators type "harbourdental.co.za", not "https://harbourdental.co.za".
  it("repairs a website with no protocol instead of producing a relative link", async () => {
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    // Scoped: the email address contains the domain too.
    expect(publicPanel().getByRole("link", { name: /^harbourdental\.co\.za/ })).toHaveAttribute(
      "href",
      "https://harbourdental.co.za",
    );
  });

  it("resolves an Instagram handle to its profile, without the @", async () => {
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    expect(publicPanel().getByRole("link", { name: "@harbourdental" })).toHaveAttribute(
      "href",
      "https://instagram.com/harbourdental",
    );
  });

  it("makes the email mailable", async () => {
    show();
    expect(await screen.findByRole("link", { name: /naledi@harbourdental/ })).toHaveAttribute(
      "href",
      "mailto:naledi@harbourdental.co.za",
    );
  });

  it("does not turn an address into a link", async () => {
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    expect(publicPanel().queryByRole("link", { name: /Bay Road/ })).not.toBeInTheDocument();
  });

  // Asserted against the clipboard's actual contents rather than a spy on
  // writeText: userEvent installs a working stub, so this checks the value
  // arrived, not merely that a function was called.
  it("copies a value to the clipboard", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    await user.click(screen.getByLabelText("Copy Phone"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("+27 21 555 0134"),
    );
  });

  it("confirms the copy, so the click has a visible result", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("heading", { name: "Harbour Dental" });
    await user.click(screen.getByLabelText("Copy Phone"));
    // The button relabels itself, so the confirmation reaches a screen
    // reader and not only a sighted user watching the icon.
    expect(await screen.findByLabelText("Phone copied")).toBeInTheDocument();
  });

  it("offers no copy button for a field with nothing in it", async () => {
    show({ ...FULL, whatsapp: null });
    await screen.findByRole("heading", { name: "Harbour Dental" });
    expect(screen.queryByLabelText("Copy WhatsApp")).not.toBeInTheDocument();
  });
});

describe("ContactPanel — the logo", () => {
  it("explains that the mark is composited, never drawn", async () => {
    show();
    expect(await screen.findByText(/never asked to draw it/i)).toBeInTheDocument();
  });

  it("offers a way to add one when it is missing", async () => {
    show({ ...FULL, logo_path: null }, "");
    expect(await screen.findByRole("button", { name: "Upload a logo" })).toBeInTheDocument();
  });

  it("opens the editor from the empty-logo prompt", async () => {
    const user = userEvent.setup();
    show({ ...FULL, logo_path: null }, "");
    await user.click(await screen.findByRole("button", { name: "Upload a logo" }));
    await waitFor(() => expect(screen.getByText(/Leave a field blank/i)).toBeInTheDocument());
  });
});
