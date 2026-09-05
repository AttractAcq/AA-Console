import { describe, expect, it } from "vitest";
import { renderToPlainText } from "./markdown";

describe("Master AI inline markdown", () => {
  it("renders bold without leaving the markers behind", () => {
    expect(renderToPlainText("**2 clients.**")).toBe("2 clients.");
  });

  it("handles bold wrapping inline code, the case a flat pass gets wrong", () => {
    // Real output: **Job `d460e0b8-…`** — ICP Agent
    expect(renderToPlainText("**Job `d460e0b8`** — ICP Agent")).toBe("Job d460e0b8 — ICP Agent");
  });

  it("handles code wrapping something that looks like bold", () => {
    expect(renderToPlainText("`a**b**c`")).toBe("a**b**c");
  });

  it("leaves underscores alone — they are identifiers here, not emphasis", () => {
    expect(renderToPlainText("agent_key and client_id in scheduled_posts")).toBe(
      "agent_key and client_id in scheduled_posts",
    );
  });

  it("does not treat a lone asterisk as the start of italics", () => {
    expect(renderToPlainText("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(renderToPlainText("unmatched **bold")).toBe("unmatched **bold");
  });

  it("renders italics only when the markers hug the words", () => {
    expect(renderToPlainText("*emphasis* here")).toBe("emphasis here");
  });

  it("keeps a colon-suffixed bold label intact", () => {
    expect(renderToPlainText("**Status:** running")).toBe("Status: running");
  });

  it("renders links by their label and drops a javascript: url", () => {
    expect(renderToPlainText("[the page](https://example.com)")).toBe("the page");
    // Not a link: falls through as literal text rather than becoming an anchor.
    expect(renderToPlainText("[x](javascript:alert(1))")).toContain("[x]");
  });

  it("leaves no bold or code markers in a realistic reply", () => {
    const reply = [
      "**Runtime: healthy.** Two workers live.",
      "- **Status:** `running`, attempt 1",
      "- Picked up by `agent-runtime:14`",
    ].join("\n");
    const flat = renderToPlainText(reply);
    expect(flat).not.toContain("**");
    expect(flat).not.toContain("`");
  });
});
