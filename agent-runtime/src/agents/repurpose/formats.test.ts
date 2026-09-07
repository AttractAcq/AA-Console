import { describe, expect, it } from "vitest";
import { FORMATS, resolveFormats } from "./formats.js";

describe("the formats a repurpose offers", () => {
  it("covers the eight the architecture names", () => {
    expect(FORMATS.map((f) => f.key).sort()).toEqual([
      "ad_variation", "carousel", "email", "quote_graphic",
      "reel", "short", "story_clips", "text_post",
    ]);
  });

  // The media type decides which Brief Studio fields are asked for and which
  // production route the derivative can take, so a wrong one is not cosmetic:
  // a reel brief without a shot list is useless to an editor.
  it("gives the video formats a video brief, so they get a shot list", () => {
    for (const key of ["reel", "short", "story_clips"]) {
      expect(FORMATS.find((f) => f.key === key)?.mediaType).toBe("video");
    }
  });

  it("gives the written formats a text brief, so the AI route can build them", () => {
    for (const key of ["text_post", "email"]) {
      expect(FORMATS.find((f) => f.key === key)?.mediaType).toBe("text");
    }
  });

  it("gives the visual formats an image brief", () => {
    for (const key of ["carousel", "quote_graphic", "ad_variation"]) {
      expect(FORMATS.find((f) => f.key === key)?.mediaType).toBe("image");
    }
  });

  // Direction is what stops a repurpose being a translation of the root.
  it("tells each format what it must do differently", () => {
    for (const f of FORMATS) expect(f.direction.length).toBeGreaterThan(60);
  });
});

describe("resolveFormats", () => {
  it("keeps the order asked for", () => {
    expect(resolveFormats(["email", "reel"]).formats.map((f) => f.key)).toEqual(["email", "reel"]);
  });

  // Reported rather than silently dropped: a typo that quietly produces four
  // briefs instead of five looks like the agent failed at one of them.
  it("reports a format it does not know instead of ignoring it", () => {
    const { formats, unknown } = resolveFormats(["reel", "podcast"]);
    expect(formats.map((f) => f.key)).toEqual(["reel"]);
    expect(unknown).toEqual(["podcast"]);
  });

  it("survives being handed something that is not a list", () => {
    expect(resolveFormats(undefined).formats).toEqual([]);
    expect(resolveFormats("reel").formats).toEqual([]);
    expect(resolveFormats(null).formats).toEqual([]);
  });

  it("returns nothing for an empty list rather than defaulting to all of them", () => {
    expect(resolveFormats([]).formats).toEqual([]);
  });
});
