import { describe, expect, it } from "vitest";

import {
  captionRemaining,
  checkCopy,
  isPlatform,
  PLATFORM_LIMITS,
  PLATFORMS,
  platformName,
} from "./platform-limits.js";

describe("checkCopy", () => {
  it("passes copy that fits", () => {
    expect(
      checkCopy("instagram", {
        caption: "Five steps, one chain.",
        hashtags: ["#agency", "content"],
        alt_text: "A row of cards joined by a line.",
        first_comment: "The full breakdown is in the bio.",
      }),
    ).toEqual([]);
  });

  it("names the platform and both numbers when the caption is too long", () => {
    const problems = checkCopy("instagram", { caption: "x".repeat(2300) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2300");
    expect(problems[0]).toContain("Instagram");
    expect(problems[0]).toContain("2,200");
  });

  it("measures the caption trimmed, so trailing whitespace is not a failure", () => {
    expect(checkCopy("instagram", { caption: `${"x".repeat(2200)}   \n` })).toEqual([]);
  });

  it("reports every problem at once rather than the first", () => {
    // A writer told about the caption, who fixes it and is then told about
    // the hashtags, has been made to do one job twice.
    const problems = checkCopy("instagram", {
      caption: "x".repeat(2300),
      hashtags: Array.from({ length: 31 }, (_, i) => `tag${i}`),
      alt_text: "y".repeat(1100),
    });
    expect(problems).toHaveLength(3);
  });

  it("refuses a link in a caption on the platforms where it would not be clickable", () => {
    const link = { caption: "Book a call", link_url: "https://attractacq.com" };
    expect(checkCopy("instagram", link)[0]).toMatch(/not clickable/);
    expect(checkCopy("tiktok", link)[0]).toMatch(/not clickable/);
    expect(checkCopy("facebook", link)).toEqual([]);
    expect(checkCopy("linkedin", link)).toEqual([]);
  });

  it("refuses something that is not a http address at all", () => {
    expect(checkCopy("facebook", { link_url: "javascript:alert(1)" })[0]).toMatch(/http or https/);
    expect(checkCopy("facebook", { link_url: "attractacq.com" })[0]).toMatch(/http or https/);
  });

  it("says so when a platform has no alt text rather than silently dropping it", () => {
    expect(checkCopy("tiktok", { alt_text: "A chair" })[0]).toMatch(/no alt text/);
    expect(checkCopy("youtube", { alt_text: "A chair" })[0]).toMatch(/no alt text/);
  });

  it("says so when a platform has no first comment", () => {
    expect(checkCopy("youtube", { first_comment: "More below" })[0]).toMatch(/no first comment/);
    expect(checkCopy("instagram", { first_comment: "More below" })).toEqual([]);
  });

  it("refuses a hashtag with characters the platform will not read", () => {
    const problems = checkCopy("instagram", { hashtags: ["#good_one", "not a tag", "also-bad"] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("not a tag");
  });

  it("takes a hashtag with or without its hash, and takes other alphabets", () => {
    expect(checkCopy("instagram", { hashtags: ["#agency", "agency", "#咖啡", "café"] })).toEqual([]);
  });

  it("treats empty and missing copy as nothing to complain about", () => {
    expect(checkCopy("instagram", {})).toEqual([]);
    expect(checkCopy("instagram", { caption: "", hashtags: [], alt_text: null, link_url: "" })).toEqual([]);
  });
});

describe("captionRemaining", () => {
  it("counts down and goes negative rather than clamping", () => {
    expect(captionRemaining("instagram", "")).toBe(2200);
    expect(captionRemaining("instagram", "x".repeat(2201))).toBe(-1);
  });
});

describe("the table itself", () => {
  it("covers every platform the database has", () => {
    // post_platform in the schema. A platform with no limits would validate
    // as fine whatever it was given.
    expect([...PLATFORMS].sort()).toEqual(["facebook", "instagram", "linkedin", "tiktok", "youtube"]);
    for (const platform of PLATFORMS) {
      expect(PLATFORM_LIMITS[platform].caption).toBeGreaterThan(0);
      expect(PLATFORM_LIMITS[platform].hashtags).toBeGreaterThan(0);
    }
  });

  it("spells the names the way the platforms do", () => {
    expect(PLATFORMS.map(platformName)).toEqual(["Facebook", "Instagram", "TikTok", "LinkedIn", "YouTube"]);
  });

  it("recognises its own platforms and nothing else", () => {
    expect(isPlatform("instagram")).toBe(true);
    expect(isPlatform("Instagram")).toBe(false);
    expect(isPlatform("threads")).toBe(false);
  });
});
