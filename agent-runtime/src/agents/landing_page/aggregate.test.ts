import { describe, expect, it } from "vitest";
import { brandPageBlock, renderPackage, type PagePackage } from "./aggregate.js";
import type { BrandProfile } from "../creative_build/brand.js";
import type { ClientIdentity } from "../identity.js";

const brand = (over: Partial<BrandProfile> = {}): BrandProfile => ({
  colour_primary: "#0F4C5C", colour_secondary: null, colour_accent: "#FB8B24",
  colour_background: null, colour_text: null,
  font_heading: "Fraunces", font_body: "Inter",
  imagery_style: null, lighting: null, mood: "Calm", composition_notes: null,
  never_do: "No gradients",
  ...over,
});

const identity: ClientIdentity = {
  businessName: "Harbour Dental",
  contactName: null, phone: "031 566 4120", whatsapp: null,
  website: "harbourdental.co.za", instagram: null, address: null,
};

describe("the brand a page is built to", () => {
  it("gives real hex, not adjectives", () => {
    const out = brandPageBlock(brand(), null);
    expect(out).toContain("Primary: #0F4C5C");
    expect(out).toMatch(/real hex values/i);
  });

  // The first consumer of custom_css, which was stored and read by nothing.
  it("passes the client's own CSS through verbatim", () => {
    const css = ".btn { border-radius: 0 }";
    const out = brandPageBlock(brand(), css);
    expect(out).toContain(css);
    expect(out).toMatch(/verbatim/i);
  });

  it("says nothing about CSS when the client has none", () => {
    expect(brandPageBlock(brand(), null)).not.toMatch(/own CSS/i);
  });

  it("carries the brand's own bans", () => {
    expect(brandPageBlock(brand(), null)).toContain("No gradients");
  });

  // Absence stated rather than left silent, so the page does not get a
  // different palette every time it is rebuilt.
  it("tells an unbranded page to choose once and stay consistent", () => {
    const out = brandPageBlock(null, null);
    expect(out).toMatch(/none on file/i);
    expect(out).toMatch(/consistent across the whole page/i);
  });
});

describe("the package handed to the builder", () => {
  const pkg = (over: Partial<PagePackage> = {}): PagePackage => ({
    brand: brand(), identity, proof: [], proofHeld: 2, ...over,
  });

  it("carries brand, identity and proof together", () => {
    const out = renderPackage(pkg(), null);
    expect(out).toContain("#0F4C5C");
    expect(out).toContain("031 566 4120");
    expect(out).toMatch(/PROOF CLEARED FOR USE/);
  });

  // A landing page is the worst place to invent a detail, so the same
  // placeholder ban the brief agent carries applies here.
  it("bans placeholders, because a page is read back to you", () => {
    expect(renderPackage(pkg(), null)).toMatch(/NEVER WRITE A PLACEHOLDER/);
  });

  it("distinguishes no proof from proof nobody cleared", () => {
    expect(renderPackage(pkg({ proofHeld: 2 }), null)).toMatch(/not cleared for use/);
    expect(renderPackage(pkg({ proofHeld: 0 }), null)).toMatch(/None on file/);
  });

  it("states what identity is missing so the page avoids it", () => {
    expect(renderPackage(pkg(), null)).toMatch(/NOT on file/);
  });
});
