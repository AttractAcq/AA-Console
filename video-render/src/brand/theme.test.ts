import { describe, expect, it } from "vitest";
import { AA_BRAND, VideoTokenOverridesSchema } from "./tokens.js";
import { buildTheme, buildThemeFromSnapshot, contrastRatio } from "./theme.js";

describe("video brand theme", () => {
  it("uses the recorded AA palette and legible caption defaults", () => {
    const theme = buildTheme(null);
    expect(theme.tokens).toEqual(AA_BRAND);
    expect(theme.tokens.colours.primary).toBe("#142B23");
    expect(theme.captionContrast).toBeGreaterThanOrEqual(4.5);
  });

  it("combines a client's base profile and explicit video overrides", () => {
    const theme = buildTheme({
      colour_primary: "#123456", colour_background: "#FAFAFA",
      font_heading: "Client Heading",
      video_tokens: { colours: { accent: "#F5A623" },
        type: { scale: { h1: 80 } }, spacing: 16 },
    });
    expect(theme.tokens.colours.primary).toBe("#123456");
    expect(theme.tokens.colours.accent).toBe("#F5A623");
    expect(theme.tokens.type.heading).toBe("Client Heading");
    expect(theme.tokens.type.scale.h1).toBe(80);
    expect(theme.tokens.type.scale.h2).toBe(AA_BRAND.type.scale.h2);
    expect(theme.tokens.spacing).toBe(16);
  });

  it("builds the same client theme from a frozen project snapshot", () => {
    const snapshot = { colour_primary: "#123456",
      font_heading: "Client Heading", never_do: "No stock imagery",
      video_tokens: { colours: { accent: "#F5A623" } } };
    expect(buildThemeFromSnapshot(snapshot).tokens.colours.primary).toBe("#123456");
    expect(buildThemeFromSnapshot(snapshot).tokens.colours.accent).toBe("#F5A623");
    expect(() => buildThemeFromSnapshot(null)).toThrow(/exact project brand/);
  });

  it("chooses a readable caption colour when the requested text fails", () => {
    const theme = buildTheme({ video_tokens: { colours: {
      background: "#FFFFFF", text: "#EEEEEE",
    } } });
    expect(theme.captionText).toBe("#000000");
    expect(contrastRatio(theme.captionBackground, theme.captionText)).toBeGreaterThanOrEqual(4.5);
  });

  it("rejects unknown roles, invalid colours, and nonpositive motion values", () => {
    expect(VideoTokenOverridesSchema.safeParse({ colours: { imagined: "#FFFFFF" } }).success).toBe(false);
    expect(VideoTokenOverridesSchema.safeParse({ colours: { primary: "blue" } }).success).toBe(false);
    expect(VideoTokenOverridesSchema.safeParse({ spacing: 0 }).success).toBe(false);
  });
});
