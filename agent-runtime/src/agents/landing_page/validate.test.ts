import { describe, expect, it } from "vitest";
import { pageProblem } from "./index.js";

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
