import { describe, expect, it } from "vitest";
import { POST_PLATFORMS, platformFromIntent, platformLabel } from "./postPlatform";

describe("platformLabel", () => {
  it("names a platform we know", () => {
    expect(platformLabel("tiktok")).toBe("TikTok");
    expect(platformLabel("instagram")).toBe("Instagram");
  });

  it("shows a dash for a post scheduled before platforms were recorded", () => {
    expect(platformLabel(null)).toBe("—");
    expect(platformLabel("")).toBe("—");
    expect(platformLabel("   ")).toBe("—");
  });

  it("shows an unknown value rather than hiding it", () => {
    expect(platformLabel("threads")).toBe("threads");
  });
});

describe("platformFromIntent", () => {
  it("picks the platform a brief names", () => {
    expect(platformFromIntent("Instagram Reel, 9:16")).toBe("instagram");
    expect(platformFromIntent("TikTok")).toBe("tiktok");
    expect(platformFromIntent("a LinkedIn carousel")).toBe("linkedin");
  });

  // A wrong pre-selection is a decision nobody made that looks like one
  // somebody did, so an ambiguous intent chooses nothing.
  it("chooses nothing when the intent names more than one", () => {
    expect(platformFromIntent("Instagram and TikTok")).toBeNull();
  });

  it("chooses nothing when the intent names none", () => {
    expect(platformFromIntent("short form video")).toBeNull();
    expect(platformFromIntent("")).toBeNull();
    expect(platformFromIntent(null)).toBeNull();
  });

  it("covers every platform in the list", () => {
    for (const p of POST_PLATFORMS) {
      expect(platformFromIntent(`for ${p.value}`), p.value).toBe(p.value);
    }
  });
});
