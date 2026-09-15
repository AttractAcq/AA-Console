import { describe, expect, it } from "vitest";
import {
  embedSnippet,
  hasWidget,
  injectWidget,
  pagePath,
  publicUrl,
  removeWidget,
  slugify,
  MAX_SLUG_LENGTH,
} from "./paths.js";

describe("slugify", () => {
  it("makes a URL segment from a real page title", () => {
    expect(slugify("Winter Full-Arch Offer")).toBe("winter-full-arch-offer");
    expect(slugify("  Emergency Dental — Umhlanga  ")).toBe("emergency-dental-umhlanga");
  });
  it("strips accents rather than dropping the word", () => {
    expect(slugify("Crème Brûlée Café")).toBe("creme-brulee-cafe");
  });
  it("cannot produce path traversal", () => {
    expect(slugify("../../.github/workflows")).toBe("github-workflows");
    expect(slugify("..")).toBe("");
    expect(slugify("/")).toBe("");
  });
  it("caps the length and leaves no trailing hyphen", () => {
    const out = slugify("a".repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(out.endsWith("-")).toBe(false);
    expect(slugify("x".repeat(MAX_SLUG_LENGTH - 1) + " y")).not.toMatch(/-$/);
  });
});

describe("pagePath", () => {
  it("gives a directory with an index, so the URL needs no extension", () => {
    expect(pagePath("Winter Offer")).toBe("winter-offer/index.html");
  });
  it("publishes as the homepage when asked", () => {
    expect(pagePath("anything at all", true)).toBe("index.html");
  });
  it("refuses a title that reduces to nothing rather than silently taking the root", () => {
    // Defaulting here would overwrite the homepage with a page called "???".
    expect(pagePath("???")).toBeNull();
    expect(pagePath("../..")).toBeNull();
    expect(pagePath("")).toBeNull();
  });
  it("refuses names that would break the site's own machinery", () => {
    expect(pagePath("aa")).toBeNull();
    expect(pagePath("assets")).toBeNull();
  });
});

describe("publicUrl", () => {
  const base = "https://attractacq.github.io/harbour-dental";
  it("serves a page directory with a trailing slash, which Pages does not redirect", () => {
    expect(publicUrl(base, "winter-offer/index.html")).toBe(
      "https://attractacq.github.io/harbour-dental/winter-offer/",
    );
  });
  it("serves the homepage at the base", () => {
    expect(publicUrl(base, "index.html")).toBe("https://attractacq.github.io/harbour-dental/");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(publicUrl(base + "/", "index.html")).toBe("https://attractacq.github.io/harbour-dental/");
  });
});

describe("embedSnippet", () => {
  it("points at the canonical runtime host, not the implementation host", () => {
    // Pointing at the Railway domain would strand every published page the day
    // the runtime moves.
    const snippet = embedSnippet("abc123", "https://runtime.attractacq.com");
    expect(snippet).toContain("https://runtime.attractacq.com/public/sales/v1/widget.js");
    expect(snippet).toContain('data-agent="abc123"');
    expect(snippet).not.toContain("railway");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(embedSnippet("x", "https://runtime.attractacq.com/")).toContain(
      "https://runtime.attractacq.com/public/sales/v1/widget.js",
    );
  });
});

describe("injectWidget", () => {
  const page = "<!doctype html><html><body><h1>Offer</h1></body></html>";
  const snippet = embedSnippet("dep1", "https://runtime.attractacq.com");

  it("puts the widget just before the body closes", () => {
    const out = injectWidget(page, snippet);
    expect(out).toContain(snippet);
    expect(out.indexOf(snippet)).toBeLessThan(out.indexOf("</body>"));
    expect(out).toContain("<h1>Offer</h1>");
  });

  it("is idempotent — republishing does not open two chat buttons", () => {
    const once = injectWidget(page, snippet);
    const twice = injectWidget(once, snippet);
    expect(twice).toBe(once);
    expect(twice.match(/data-agent=/g)).toHaveLength(1);
  });

  it("replaces an older agent rather than stacking a second one", () => {
    const first = injectWidget(page, embedSnippet("old", "https://runtime.attractacq.com"));
    const second = injectWidget(first, embedSnippet("new", "https://runtime.attractacq.com"));
    expect(second).toContain('data-agent="new"');
    expect(second).not.toContain('data-agent="old"');
    expect(second.match(/data-agent=/g)).toHaveLength(1);
  });

  it("handles an uppercase closing tag", () => {
    const out = injectWidget("<HTML><BODY>hi</BODY></HTML>", snippet);
    expect(out).toContain(snippet);
    expect(out.indexOf(snippet)).toBeLessThan(out.indexOf("</BODY>"));
  });

  it("handles whitespace inside the closing tag", () => {
    const out = injectWidget("<body>hi</body >", snippet);
    expect(out).toContain(snippet);
  });

  it("still injects into a fragment with no body", () => {
    const out = injectWidget("<h1>fragment</h1>", snippet);
    expect(out).toContain(snippet);
  });
});

describe("removeWidget", () => {
  const page = "<!doctype html><html><body><h1>Offer</h1></body></html>";
  it("takes the agent off and leaves the page as it was", () => {
    const withAgent = injectWidget(page, embedSnippet("dep1", "https://runtime.attractacq.com"));
    expect(removeWidget(withAgent)).toBe(page);
  });
  it("does nothing to a page that never had one", () => {
    expect(removeWidget(page)).toBe(page);
  });
});

describe("hasWidget", () => {
  it("reports whether a page carries an agent", () => {
    const page = "<body>x</body>";
    expect(hasWidget(page)).toBe(false);
    expect(hasWidget(injectWidget(page, embedSnippet("d", "https://r.example")))).toBe(true);
  });
});
