import { describe, expect, it } from "vitest";

import { compose } from "./caption.js";
import { PLATFORM_LIMITS } from "../content/platform-limits.js";

describe("the words, assembled", () => {
  it("puts the caption, then the hashtags", () => {
    const { caption } = compose("instagram", { caption: "Five steps, one chain.", hashtags: ["proof", "#two"] });
    expect(caption).toBe("Five steps, one chain.\n\n#proof #two");
  });

  it("normalises a hashtag however it was written down", () => {
    const { caption } = compose("instagram", { caption: "x", hashtags: ["  ##one ", "two", "", "   "] });
    expect(caption).toBe("x\n\n#one #two");
  });

  it("keeps a body link where it is clickable", () => {
    const { caption, firstComment } = compose("facebook", {
      caption: "Read it.",
      link_url: "https://example.com/a",
    });
    expect(caption).toContain("https://example.com/a");
    expect(firstComment).toBeNull();
  });

  it("moves a link to the first comment where the body ignores it", () => {
    // A link in an Instagram caption is not clickable, so copy that puts one
    // there is copy that wastes the line.
    const { caption, firstComment } = compose("instagram", {
      caption: "Read it.",
      link_url: "https://example.com/a",
    });
    expect(caption).not.toContain("https://example.com");
    expect(firstComment).toBe("https://example.com/a");
  });

  it("keeps the writer's own first comment alongside the moved link", () => {
    const { firstComment } = compose("instagram", {
      caption: "x",
      link_url: "https://example.com/a",
      first_comment: "More below.",
    });
    expect(firstComment).toBe("More below.\n\nhttps://example.com/a");
  });

  it("drops a first comment on a platform that has none", () => {
    const { firstComment } = compose("youtube", { caption: "x", first_comment: "More below." });
    expect(firstComment).toBeNull();
  });

  it("stops at the platform's hashtag count", () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const { caption } = compose("youtube", { caption: "x", hashtags: many });
    expect(caption.match(/#/g)).toHaveLength(PLATFORM_LIMITS.youtube.hashtags);
  });

  it("refuses rather than truncating when it will not fit", () => {
    // A caption cut off mid-sentence reaches the client's audience. A post
    // that did not go out reaches a board.
    const long = "a".repeat(PLATFORM_LIMITS.instagram.caption);
    expect(() => compose("instagram", { caption: long, hashtags: ["proof"] })).toThrow(/limit is 2200/);
  });

  it("counts the hashtags against the limit, not just the caption", () => {
    const nearly = "a".repeat(PLATFORM_LIMITS.instagram.caption - 4);
    expect(() => compose("instagram", { caption: nearly, hashtags: ["proof"] })).toThrow(/characters with its hashtags/);
  });

  it("refuses an empty caption", () => {
    expect(() => compose("instagram", { caption: "   " })).toThrow(/no caption for instagram/);
    expect(() => compose("instagram", {})).toThrow(/no caption/);
  });

  it("gives the same answer twice", () => {
    const copy = { caption: "x", hashtags: ["a", "b"], link_url: "https://e.com", first_comment: "y" };
    expect(compose("instagram", copy)).toEqual(compose("instagram", copy));
  });
});
