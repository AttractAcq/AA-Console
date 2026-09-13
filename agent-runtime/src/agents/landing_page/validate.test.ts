import { describe, expect, it } from "vitest";
import { htmlSafetyProblem, pageProblem } from "./safety.js";

const ok = "<!doctype html><html><head><style>body{color:#000}</style></head><body><h1>Hi</h1>" +
  "x".repeat(900) + "</body></html>";

describe("what a generated page must not contain", () => {
  it("accepts a plain, self-contained page", () => {
    expect(pageProblem("Straighter teeth", ok)).toBeNull();
  });

  // This is the rule that means the preview sandbox is never tested in anger.
  it("rejects a script tag", () => {
    expect(pageProblem("h", ok.replace("<h1>", "<script>alert(1)</script><h1>"))).toMatch(/script/i);
  });

  it("rejects a script tag whatever its case or attributes", () => {
    expect(pageProblem("h", ok.replace("<h1>", '<SCRIPT src="x">'))).toMatch(/script/i);
  });

  // Script by another name. A rule that only looked for <script> would let
  // this through, and it runs anywhere the sandbox is not present.
  it("rejects an inline event handler", () => {
    expect(pageProblem("h", ok.replace("<h1>", '<div onclick="steal()">'))).toMatch(/inline event handler/i);
    expect(pageProblem("h", ok.replace("<h1>", '<img onerror="x">'))).toMatch(/inline event handler/i);
  });

  it("rejects an iframe, which can carry anything", () => {
    expect(pageProblem("h", ok.replace("<h1>", '<iframe src="//evil">'))).toMatch(/iframe/i);
  });

  // Not every "on" is a handler. "London" in body copy must not fail a build.
  it("does not mistake ordinary words for handlers", () => {
    expect(pageProblem("h", ok.replace("<h1>Hi", "<h1>London and Manchester"))).toBeNull();
    expect(pageProblem("h", ok.replace("<h1>Hi", "<h1>Only one thing"))).toBeNull();
  });
});

describe("what a generated page must contain", () => {
  it("rejects a page with no headline", () => {
    expect(pageProblem("", ok)).toMatch(/no headline/i);
  });

  it("rejects a page too thin to be a page", () => {
    expect(pageProblem("h", "<html><body>hi</body></html>")).toMatch(/too thin/i);
  });
});

describe("the revision path cannot be weaker than the generation path", () => {
  // The Page Reviser writes client_pages.html too. If it enforced a different
  // set of rules, a revision could introduce exactly what generation forbids —
  // and after Phase 10 these pages are served publicly with no sandbox.
  const ok = "<!doctype html><html><body><h1>Hi</h1>" + "x".repeat(900) + "</body></html>";

  it("rejects through htmlSafetyProblem everything pageProblem rejects about the HTML", () => {
    const hostile = [
      ok.replace("<h1>", "<script>alert(1)</script><h1>"),
      ok.replace("<h1>", '<div onclick="steal()">'),
      ok.replace("<h1>", '<iframe src="//evil">'),
      "<html><body>too short</body></html>",
    ];
    for (const html of hostile) {
      expect(htmlSafetyProblem(html)).not.toBeNull();
      // Same verdict from both entry points, so neither can drift.
      expect(pageProblem("a headline", html)).toBe(htmlSafetyProblem(html));
    }
  });

  it("accepts a clean page through both", () => {
    expect(htmlSafetyProblem(ok)).toBeNull();
    expect(pageProblem("a headline", ok)).toBeNull();
  });

  it("does not require a headline of a revision", () => {
    // A revision that changes a mid-page section has no new headline to state.
    expect(htmlSafetyProblem(ok)).toBeNull();
    expect(pageProblem("", ok)).toMatch(/no headline/i);
  });
});
