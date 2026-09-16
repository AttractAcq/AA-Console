import type { FieldDef, FormValues } from "../components/forms/fields";

/**
 * Contract-ready identity and contact for a team member (avatar, editor, SMM).
 *
 * These fields live as columns on team_members. The older personal_info /
 * contact_info text blobs remain on the row so existing data is never wiped;
 * resolveTeamMemberProfile() maps that free text into these fields when the
 * structured columns are still empty.
 */
export type TeamMemberProfile = {
  given_name: string | null;
  family_name: string | null;
  preferred_name: string | null;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
  company_name: string | null;
  tax_id: string | null;
  profile_notes: string | null;
};

export const TEAM_MEMBER_PROFILE_KEYS = [
  "given_name",
  "family_name",
  "preferred_name",
  "legal_name",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "address_city",
  "address_region",
  "address_postal_code",
  "address_country",
  "company_name",
  "tax_id",
  "profile_notes",
] as const satisfies ReadonlyArray<keyof TeamMemberProfile>;

export type TeamMemberProfileKey = (typeof TEAM_MEMBER_PROFILE_KEYS)[number];

export type TeamMemberProfileRow = TeamMemberProfile & {
  personal_info: string | null;
  contact_info: string | null;
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+|00)?[0-9][0-9\s().-]{5,18}[0-9]/;

export const emptyTeamMemberProfile = (): TeamMemberProfile => ({
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
});

function blankToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function profileFromRow(row: Partial<TeamMemberProfile> | null | undefined): TeamMemberProfile {
  const out = emptyTeamMemberProfile();
  if (!row) return out;
  for (const key of TEAM_MEMBER_PROFILE_KEYS) {
    out[key] = blankToNull(row[key]);
  }
  return out;
}

export function extractEmail(text: string): { email: string | null; rest: string } {
  const match = text.match(EMAIL_RE);
  if (!match || match.index === undefined) return { email: null, rest: text };
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  return { email: match[0], rest: collapseEmpty(rest) };
}

export function extractPhone(text: string): { phone: string | null; rest: string } {
  const match = text.match(PHONE_RE);
  if (!match || match.index === undefined) return { phone: null, rest: text };
  const digits = match[0].replace(/\D/g, "");
  if (digits.length < 7) return { phone: null, rest: text };
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  return { phone: match[0].trim(), rest: collapseEmpty(rest) };
}

/**
 * Treat a short, single-line, letter-ish blob as a person's name.
 * Anything with digits, an @, or a newline is notes, not a name.
 */
export function parsePersonName(text: string): { given: string; family: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed || /[\n\r@\d]/.test(trimmed) || trimmed.length > 80) return null;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return null;
  if (words.length === 1) return { given: words[0]!, family: null };
  return { given: words[0]!, family: words.slice(1).join(" ") };
}

function collapseEmpty(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseFreeTextProfile(
  personalInfo: string | null | undefined,
  contactInfo: string | null | undefined,
): TeamMemberProfile {
  const out = emptyTeamMemberProfile();
  let personal = personalInfo ?? "";
  let contact = contactInfo ?? "";

  const fromContactEmail = extractEmail(contact);
  if (fromContactEmail.email) {
    out.email = fromContactEmail.email;
    contact = fromContactEmail.rest;
  } else {
    const fromPersonalEmail = extractEmail(personal);
    if (fromPersonalEmail.email) {
      out.email = fromPersonalEmail.email;
      personal = fromPersonalEmail.rest;
    }
  }

  const fromContactPhone = extractPhone(contact);
  if (fromContactPhone.phone) {
    out.phone = fromContactPhone.phone;
    contact = fromContactPhone.rest;
  }

  const name = parsePersonName(personal);
  if (name) {
    out.given_name = name.given;
    out.family_name = name.family;
    personal = "";
  }

  out.profile_notes = blankToNull([personal, contact].map(collapseEmpty).filter(Boolean).join("\n\n"));
  return out;
}

/** Structured columns win; free-text fills anything still empty. */
export function resolveTeamMemberProfile(row: TeamMemberProfileRow | null | undefined): TeamMemberProfile {
  const structured = profileFromRow(row);
  if (!row) return structured;
  const parsed = parseFreeTextProfile(row.personal_info, row.contact_info);
  const out = emptyTeamMemberProfile();
  for (const key of TEAM_MEMBER_PROFILE_KEYS) {
    out[key] = structured[key] ?? parsed[key];
  }
  return out;
}

export function profileHasPersonal(profile: TeamMemberProfile): boolean {
  return Boolean(
    profile.given_name ||
      profile.family_name ||
      profile.preferred_name ||
      profile.legal_name ||
      profile.company_name ||
      profile.tax_id ||
      profile.profile_notes,
  );
}

export function profileHasContact(profile: TeamMemberProfile): boolean {
  return Boolean(
    profile.email ||
      profile.phone ||
      profile.address_line1 ||
      profile.address_line2 ||
      profile.address_city ||
      profile.address_region ||
      profile.address_postal_code ||
      profile.address_country,
  );
}

export function formatAddress(profile: TeamMemberProfile): string | null {
  const line3 = [profile.address_city, profile.address_region, profile.address_postal_code]
    .filter(Boolean)
    .join(" ");
  const lines = [profile.address_line1, profile.address_line2, line3 || null, profile.address_country].filter(
    (line): line is string => Boolean(line),
  );
  return lines.length > 0 ? lines.join("\n") : null;
}

export type ProfileEntry = {
  label: string;
  value: string;
  href?: string;
  multiline?: boolean;
};

export function personalEntries(profile: TeamMemberProfile): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  const push = (label: string, value: string | null) => {
    if (value) entries.push({ label, value });
  };
  push("Given name", profile.given_name);
  push("Surname", profile.family_name);
  push("Preferred name", profile.preferred_name);
  push("Legal name", profile.legal_name);
  push("Company", profile.company_name);
  push("Tax ID / VAT", profile.tax_id);
  if (profile.profile_notes) {
    entries.push({ label: "Notes", value: profile.profile_notes, multiline: true });
  }
  return entries;
}

export function contactEntries(profile: TeamMemberProfile): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  if (profile.email) {
    entries.push({ label: "Email", value: profile.email, href: `mailto:${profile.email}` });
  }
  if (profile.phone) {
    entries.push({
      label: "Phone",
      value: profile.phone,
      href: `tel:${profile.phone.replace(/[^\d+]/g, "")}`,
    });
  }
  const address = formatAddress(profile);
  if (address) entries.push({ label: "Address", value: address, multiline: true });
  return entries;
}

export function profileToFormValues(profile: TeamMemberProfile): FormValues {
  return Object.fromEntries(TEAM_MEMBER_PROFILE_KEYS.map((key) => [key, profile[key] ?? ""]));
}

export function profileFromFormValues(values: FormValues): TeamMemberProfile {
  const out = emptyTeamMemberProfile();
  for (const key of TEAM_MEMBER_PROFILE_KEYS) {
    const value = values[key];
    out[key] = typeof value === "string" ? blankToNull(value) : null;
  }
  return out;
}

export const TEAM_MEMBER_PROFILE_FIELDS: FieldDef[] = [
  { name: "_personal_heading", label: "Personal", kind: "heading" },
  {
    name: "given_name",
    label: "Given name",
    kind: "text",
    placeholder: "First name",
    autoComplete: "given-name",
  },
  {
    name: "family_name",
    label: "Surname",
    kind: "text",
    placeholder: "Family name",
    autoComplete: "family-name",
  },
  {
    name: "preferred_name",
    label: "Preferred name",
    kind: "text",
    hint: "If they go by something other than their given name.",
    autoComplete: "nickname",
  },
  {
    name: "legal_name",
    label: "Legal name",
    kind: "text",
    hint: "As it should appear on a contract, if that is not given name + surname.",
    autoComplete: "name",
  },
  {
    name: "company_name",
    label: "Company",
    kind: "text",
    hint: "If invoices are issued by a company rather than in a personal name.",
    autoComplete: "organization",
  },
  {
    name: "tax_id",
    label: "Tax ID / VAT",
    kind: "text",
    hint: "VAT, GST, or other tax identifier used on invoices.",
  },
  { name: "_contact_heading", label: "Contact", kind: "heading" },
  {
    name: "email",
    label: "Email",
    kind: "text",
    inputType: "email",
    placeholder: "name@example.com",
    autoComplete: "email",
  },
  {
    name: "phone",
    label: "Phone",
    kind: "text",
    inputType: "tel",
    placeholder: "+27 82 000 0000",
    hint: "Include the country code.",
    autoComplete: "tel",
  },
  { name: "_address_heading", label: "Address", kind: "heading" },
  {
    name: "address_line1",
    label: "Street address",
    kind: "text",
    autoComplete: "address-line1",
  },
  {
    name: "address_line2",
    label: "Apartment, suite, etc.",
    kind: "text",
    autoComplete: "address-line2",
  },
  {
    name: "address_city",
    label: "City",
    kind: "text",
    autoComplete: "address-level2",
  },
  {
    name: "address_region",
    label: "Region / state",
    kind: "text",
    autoComplete: "address-level1",
  },
  {
    name: "address_postal_code",
    label: "Postal code",
    kind: "text",
    autoComplete: "postal-code",
  },
  {
    name: "address_country",
    label: "Country",
    kind: "text",
    placeholder: "South Africa",
    autoComplete: "country-name",
  },
  {
    name: "profile_notes",
    label: "Notes",
    kind: "textarea",
    rows: 3,
    hint: "Anything that does not fit a named field. Previous free-text that could not be mapped lands here.",
  },
];

export const TEAM_MEMBER_PROFILE_SELECT =
  "personal_info, contact_info, given_name, family_name, preferred_name, legal_name, email, phone, address_line1, address_line2, address_city, address_region, address_postal_code, address_country, company_name, tax_id, profile_notes";
