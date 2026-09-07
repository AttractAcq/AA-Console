import { describe, expect, it } from "vitest";
import { identityWriterBlock, type ClientIdentity } from "./identity.js";

const base: ClientIdentity = {
  businessName: "Harbour Dental",
  contactName: null, phone: null, whatsapp: null,
  website: null, instagram: null, address: null,
};
const id = (over: Partial<ClientIdentity> = {}): ClientIdentity => ({ ...base, ...over });

describe("what a writing agent is told about identity", () => {
  it("always names the business, and says it is the only name", () => {
    const out = identityWriterBlock(id());
    expect(out).toContain('The business is "Harbour Dental"');
    expect(out).toMatch(/only name/i);
  });

  // The fix this exists for: a brief said "[NAMED PERSON] picks it up" while
  // a named contact sat on file, unread.
  it("gives the named contact when there is one", () => {
    expect(identityWriterBlock(id({ contactName: "Dr Naledi Khumalo" }))).toContain(
      'The person who answers is exactly "Dr Naledi Khumalo"',
    );
  });

  it("quotes each detail verbatim rather than describing it", () => {
    const out = identityWriterBlock(id({ phone: "+27 21 555 0134", website: "harbourdental.co.za" }));
    expect(out).toContain('exactly "+27 21 555 0134"');
    expect(out).toContain('exactly "harbourdental.co.za"');
    expect(out).toMatch(/character for character/);
  });

  // Absence stated, not left silent — the rule the whole system follows.
  it("names what is missing so the writer avoids it", () => {
    const out = identityWriterBlock(id({ phone: "+27 21 555 0134" }));
    expect(out).toMatch(/NOT on file/);
    expect(out).toContain("a website or URL");
    expect(out).toContain("a named person");
    expect(out).not.toContain("a phone number,"); // the one we do have
  });

  it("says so plainly when nothing is missing", () => {
    const out = identityWriterBlock(
      id({
        contactName: "A", phone: "B", whatsapp: "C",
        website: "D", instagram: "E", address: "F",
      }),
    );
    expect(out).toMatch(/Everything this piece might need is listed/);
    expect(out).not.toMatch(/NOT on file/);
  });

  // Naming the failure is what stops it. A generic "be accurate" would not
  // have prevented [NAMED PERSON].
  it("bans placeholders by example, not in the abstract", () => {
    const out = identityWriterBlock(id());
    expect(out).toContain("[NAMED PERSON]");
    expect(out).toMatch(/NEVER WRITE A PLACEHOLDER/);
  });

  it("explains why: the brief is read by the creative agents too", () => {
    expect(identityWriterBlock(id())).toMatch(/creative agents downstream/i);
  });
});
