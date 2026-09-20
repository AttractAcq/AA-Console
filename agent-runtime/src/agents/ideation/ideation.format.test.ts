import { describe, expect, it } from "vitest";
import { mediaAndFormat } from "./index.js";

describe("mediaAndFormat", () => {
  it("keeps a shape the media type can carry", () => {
    expect(mediaAndFormat({ media_type: "image", content_format: "carousel" })).toEqual({
      media_type: "image",
      content_format: "carousel",
    });
    expect(mediaAndFormat({ media_type: "video", content_format: "story" })).toEqual({
      media_type: "video",
      content_format: "story",
    });
  });

  // The whole batch is one insert statement. A pairing the check constraint
  // refuses would lose every idea in the run, not just this one.
  it("files a self-contradicting idea as a single rather than losing it", () => {
    expect(mediaAndFormat({ media_type: "video", content_format: "carousel" })).toEqual({
      media_type: "video",
      content_format: "single",
    });
    expect(mediaAndFormat({ media_type: "text", content_format: "story" })).toEqual({
      media_type: "text",
      content_format: "single",
    });
  });

  it("defaults a missing format to single", () => {
    expect(mediaAndFormat({ media_type: "image" }).content_format).toBe("single");
  });

  it("keeps the existing fallback when the media type is unreadable", () => {
    expect(mediaAndFormat({ media_type: "gif", content_format: "carousel" })).toEqual({
      media_type: "video",
      content_format: "single",
    });
  });
});
