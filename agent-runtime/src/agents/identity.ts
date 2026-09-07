import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The client's real, checkable details, for agents that write words a person
 * or a renderer will later treat as fact.
 *
 * This exists because a brief came back saying "[NAMED PERSON] picks it up".
 * Harbour Dental has a named contact on file; the brief agent simply was not
 * given it, so it did the reasonable thing and left a gap for someone to fill.
 * That is fine while a human reads the brief and wrong the moment the brief
 * feeds a creative stage, which it does — the concept is written from the
 * brief body. A placeholder that survives one more hop becomes an invention.
 *
 * Deliberately separate from creative_build's own `identityLines`. That block
 * instructs a *renderer* — it talks about leaving a band for a logo and never
 * drawing a wordmark. This one instructs a *writer*. Same facts, different
 * audience, and merging them would blunt both.
 */
export interface ClientIdentity {
  businessName: string;
  contactName: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  instagram: string | null;
  address: string | null;
}

export async function loadIdentity(
  sb: SupabaseClient,
  clientId: string,
  businessName: string,
): Promise<ClientIdentity> {
  const { data } = await sb
    .from("client_contact_details")
    .select("primary_contact, phone, whatsapp, website, instagram, address")
    .eq("client_id", clientId)
    .maybeSingle();
  const c = (data ?? {}) as Record<string, string | null>;
  return {
    businessName,
    contactName: c.primary_contact || null,
    phone: c.phone || null,
    whatsapp: c.whatsapp || null,
    website: c.website || null,
    instagram: c.instagram || null,
    address: c.address || null,
  };
}

/**
 * What a writing agent is told. Each detail is given verbatim or its absence
 * is stated — the rule identity has followed since a renderer invented a
 * practice name — and placeholders are banned by name, because naming the
 * failure is what stops it.
 */
export function identityWriterBlock(identity: ClientIdentity): string {
  const known: string[] = [`The business is "${identity.businessName}". That is the only name for it.`];
  const missing: string[] = [];

  const rule = (label: string, value: string | null, absent: string) => {
    if (value) known.push(`${label} is exactly "${value}". Use it character for character.`);
    else missing.push(absent);
  };

  rule("The person who answers", identity.contactName, "a named person");
  rule("The phone number", identity.phone, "a phone number");
  rule("The WhatsApp number", identity.whatsapp, "a WhatsApp number");
  rule("The website", identity.website, "a website or URL");
  rule("The Instagram handle", identity.instagram, "a social handle");
  rule("The address", identity.address, "an address, street or suburb");

  return [
    "IDENTITY ON FILE — real values, and the only ones that exist",
    ...known,
    missing.length
      ? `NOT on file, so do not refer to ${missing.join(", ")} anywhere in this brief.`
      : "Everything this piece might need is listed above.",
    "",
    "NEVER WRITE A PLACEHOLDER. Not [NAMED PERSON], not \"the practice's number\",",
    "not \"insert website here\". A brief is read by a maker and its words are also",
    "read by the creative agents downstream, so a placeholder does not stay a gap —",
    "it gets filled in with something plausible and false. If a detail is not listed",
    "above, write the piece so it does not need that detail at all.",
  ].join("\n");
}
