import { describe, expect, it } from "vitest";
import {
  contactEntries,
  extractEmail,
  extractPhone,
  formatAddress,
  parseFreeTextProfile,
  parsePersonName,
  personalEntries,
  profileFromFormValues,
  profileHasContact,
  profileHasPersonal,
  resolveTeamMemberProfile,
} from "./teamMemberProfile";

describe("extractEmail", () => {
  it("pulls an address out of a contact blob and leaves the rest", () => {
    const { email, rest } = extractEmail("Alexander.thomas2401@gmail.com");
    expect(email).toBe("Alexander.thomas2401@gmail.com");
    expect(rest).toBe("");
  });

  it("keeps surrounding notes", () => {
    const { email, rest } = extractEmail("Reach me at naledi@harbourdental.co.za after 5pm");
    expect(email).toBe("naledi@harbourdental.co.za");
    expect(rest).toBe("Reach me at after 5pm");
  });

  it("returns null when there is no address", () => {
    expect(extractEmail("no address here").email).toBeNull();
  });
});

describe("extractPhone", () => {
  it("keeps a country-coded number", () => {
    const { phone, rest } = extractPhone("WhatsApp +27 82 555 0134 please");
    expect(phone).toBe("+27 82 555 0134");
    expect(rest).toBe("WhatsApp please");
  });

  it("ignores short digit runs so a postal code is not a phone", () => {
    expect(extractPhone("Cape Town 8001").phone).toBeNull();
  });
});

describe("parsePersonName", () => {
  it("splits a two-word line into given and family", () => {
    expect(parsePersonName("Naledi Khumalo")).toEqual({ given: "Naledi", family: "Khumalo" });
  });

  it("treats a single word as a given name", () => {
    expect(parsePersonName("Naledi")).toEqual({ given: "Naledi", family: null });
  });

  it("does not treat a paragraph, an email, or a numbered line as a name", () => {
    expect(parsePersonName("Lives in Cape Town\nPrefers mornings")).toBeNull();
    expect(parsePersonName("naledi@harbourdental.co.za")).toBeNull();
    expect(parsePersonName("Studio 12")).toBeNull();
  });
});

describe("parseFreeTextProfile", () => {
  it("maps the screenshot case: contact holds a raw email", () => {
    const profile = parseFreeTextProfile(null, "Alexander.thomas2401@gmail.com");
    expect(profile.email).toBe("Alexander.thomas2401@gmail.com");
    expect(profile.profile_notes).toBeNull();
  });

  it("keeps leftover personal notes after taking a name", () => {
    const profile = parseFreeTextProfile("Naledi Khumalo", "naledi@harbourdental.co.za\n+27 21 555 0134");
    expect(profile.given_name).toBe("Naledi");
    expect(profile.family_name).toBe("Khumalo");
    expect(profile.email).toBe("naledi@harbourdental.co.za");
    expect(profile.phone).toBe("+27 21 555 0134");
    expect(profile.profile_notes).toBeNull();
  });

  it("parks unmapped free text in notes so nothing is dropped", () => {
    const profile = parseFreeTextProfile(
      "Prefers morning shoots. Allergic to lilies.",
      "Send contracts to the studio.",
    );
    expect(profile.given_name).toBeNull();
    expect(profile.email).toBeNull();
    expect(profile.profile_notes).toBe("Prefers morning shoots. Allergic to lilies.\n\nSend contracts to the studio.");
  });
});

describe("resolveTeamMemberProfile", () => {
  it("lets a structured email win over a different blob", () => {
    const profile = resolveTeamMemberProfile({
      ...emptyRow(),
      email: "new@attractacq.com",
      contact_info: "old@example.com",
    });
    expect(profile.email).toBe("new@attractacq.com");
  });

  it("fills structured gaps from leftover blobs", () => {
    const profile = resolveTeamMemberProfile({
      ...emptyRow(),
      contact_info: "Alexander.thomas2401@gmail.com",
    });
    expect(profile.email).toBe("Alexander.thomas2401@gmail.com");
  });

  it("does not wipe stored notes when the blobs are empty", () => {
    const profile = resolveTeamMemberProfile({
      ...emptyRow(),
      profile_notes: "Existing note",
      personal_info: null,
      contact_info: null,
    });
    expect(profile.profile_notes).toBe("Existing note");
  });
});

describe("display helpers", () => {
  it("formats a postal address as lines, not JSON", () => {
    expect(
      formatAddress({
        ...emptyRow(),
        address_line1: "12 Bay Road",
        address_city: "Cape Town",
        address_region: "Western Cape",
        address_postal_code: "8001",
        address_country: "South Africa",
      }),
    ).toBe("12 Bay Road\nCape Town Western Cape 8001\nSouth Africa");
  });

  it("omits empty personal/contact groups", () => {
    const empty = emptyRow();
    expect(profileHasPersonal(empty)).toBe(false);
    expect(profileHasContact(empty)).toBe(false);
    expect(personalEntries(empty)).toEqual([]);
    expect(contactEntries(empty)).toEqual([]);
  });

  it("makes email and phone actionable without dumping the row", () => {
    const entries = contactEntries({
      ...emptyRow(),
      email: "naledi@harbourdental.co.za",
      phone: "+27 21 555 0134",
    });
    expect(JSON.stringify(entries)).not.toMatch(/given_name|address_line1/);
    expect(entries[0]).toMatchObject({ href: "mailto:naledi@harbourdental.co.za" });
    expect(entries[1]).toMatchObject({ href: "tel:+27215550134" });
  });

  it("round-trips form values without turning blanks into empty strings in the payload", () => {
    const profile = profileFromFormValues({
      given_name: " Naledi ",
      family_name: "  ",
      email: "naledi@harbourdental.co.za",
    });
    expect(profile.given_name).toBe("Naledi");
    expect(profile.family_name).toBeNull();
    expect(profile.email).toBe("naledi@harbourdental.co.za");
  });
});

function emptyRow() {
  return {
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
    contact_info: null,
  };
}
