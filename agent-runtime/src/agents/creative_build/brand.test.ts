import { describe, expect, it } from "vitest";
import { brandConceptBlock, brandRenderBlock, hasBrand, type BrandProfile } from "./brand.js";

const empty: BrandProfile = {
  colour_primary: null, colour_secondary: null, colour_accent: null,
  colour_background: null, colour_text: null,
  font_heading: null, font_body: null,
  imagery_style: null, lighting: null, mood: null, composition_notes: null,
  never_do: null,
};

const brand = (over: Partial<BrandProfile> = {}): BrandProfile => ({ ...empty, ...over });

describe("hasBrand", () => {
  it("treats no profile and an empty profile the same", () => {
    expect(hasBrand(null)).toBe(false);
    expect(hasBrand(empty)).toBe(false);
  });

  // A row that exists but was never filled in must not read as "on brand".
  it("ignores whitespace-only values", () => {
    expect(hasBrand(brand({ colour_primary: "   " }))).toBe(false);
  });

  it("is true as soon as one field carries something", () => {
    expect(hasBrand(brand({ mood: "calm" }))).toBe(true);
  });
});

describe("brandRenderBlock — where the pixels are decided", () => {
  // "On brand" means nothing to an image model. A hex value does.
  it("quotes hex values literally", () => {
    const out = brandRenderBlock(brand({ colour_primary: "#0064EB", colour_accent: "#FF8800" }));
    expect(out).toContain("exactly #0064EB");
    expect(out).toContain("exactly #FF8800");
  });

  it("tells the renderer not to introduce a competing dominant colour", () => {
    expect(brandRenderBlock(brand({ colour_primary: "#0064EB" }))).toMatch(/competing dominant colour/i);
  });

  // The identity lesson: absence must be stated, not left blank, or the model
  // fills the silence with something plausible and different each time.
  it("states the absence rather than saying nothing", () => {
    const out = brandRenderBlock(null);
    expect(out).toMatch(/No brand palette is on file/i);
    expect(out).toMatch(/hold it across the whole image/i);
  });

  it("says nothing about colours it does not have", () => {
    const out = brandRenderBlock(brand({ colour_primary: "#0064EB" }));
    expect(out).toContain("#0064EB");
    expect(out).not.toMatch(/secondary colour/i);
    expect(out).not.toMatch(/accent colour/i);
  });

  it("carries the brand's own bans", () => {
    expect(brandRenderBlock(brand({ never_do: "stock handshakes" }))).toContain("stock handshakes");
  });

  it("passes typography through as a family to imitate", () => {
    const out = brandRenderBlock(brand({ font_heading: "Inter" }));
    expect(out).toMatch(/Headings are set in Inter/);
  });
});

describe("brandConceptBlock — where art direction is written", () => {
  // The concept writes art_direction, so the brand has to constrain what it
  // writes rather than arrive afterwards and contradict it.
  it("tells the concept to express the system, not replace it", () => {
    const out = brandConceptBlock(brand({ colour_primary: "#0064EB" }));
    expect(out).toMatch(/EXPRESSES this system rather than replacing it/);
    expect(out).toMatch(/do not propose a different/i);
  });

  it("gives it somewhere to put a genuine conflict", () => {
    expect(brandConceptBlock(brand({ mood: "sober" }))).toMatch(/say so in rationale/i);
  });

  // Without a brand, the concept should still pin a palette down in writing,
  // so the next asset has something to match.
  it("asks an unbranded concept to state what it chose", () => {
    const out = brandConceptBlock(null);
    expect(out).toMatch(/none on file/i);
    expect(out).toMatch(/state them explicitly in art_direction/i);
    expect(out).toMatch(/a later asset can be made to match/i);
  });

  it("includes treatment as guidance", () => {
    const out = brandConceptBlock(brand({ imagery_style: "documentary photography", lighting: "hard sun" }));
    expect(out).toContain("documentary photography");
    expect(out).toContain("hard sun");
  });
});
