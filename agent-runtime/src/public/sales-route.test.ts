import { describe, expect, it } from "vitest";
import { isPublicSalesRequest, parsePath } from "./sales-route.js";
import { WIDGET_SOURCE } from "./widget.js";

describe("parsePath", () => {
  const ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

  it("reads the deployment id and action", () => {
    expect(parsePath(`/public/sales/v1/d/${ID}/message`)).toEqual({ publicId: ID, action: "message" });
    expect(parsePath(`/public/sales/v1/d/${ID}/config`)).toEqual({ publicId: ID, action: "config" });
  });

  it("ignores a query string", () => {
    expect(parsePath(`/public/sales/v1/d/${ID}/message?t=1`)?.action).toBe("message");
  });

  it("refuses an unknown action rather than falling through", () => {
    expect(parsePath(`/public/sales/v1/d/${ID}/admin`)).toBeNull();
    expect(parsePath(`/public/sales/v1/d/${ID}/`)).toBeNull();
    expect(parsePath(`/public/sales/v1/d/${ID}`)).toBeNull();
  });

  it("refuses an id that is not a hex token", () => {
    // The id is generated as hex. Anything else is someone probing.
    expect(parsePath("/public/sales/v1/d/../../etc/passwd/message")).toBeNull();
    expect(parsePath("/public/sales/v1/d/%2e%2e%2f/message")).toBeNull();
    expect(parsePath("/public/sales/v1/d/short/message")).toBeNull();
    expect(parsePath("/public/sales/v1/d/not-hex-at-all-zz/message")).toBeNull();
  });

  it("refuses a path outside the deployment namespace", () => {
    expect(parsePath("/public/sales/v1/message")).toBeNull();
    expect(parsePath("/internal/mcp/content/generate-brief")).toBeNull();
    expect(parsePath("/master/chat")).toBeNull();
    expect(parsePath(undefined)).toBeNull();
  });
});

describe("isPublicSalesRequest", () => {
  it("claims only its own namespace", () => {
    expect(isPublicSalesRequest("/public/sales/v1/d/abc/message")).toBe(true);
    expect(isPublicSalesRequest("/public/sales/v1/anything")).toBe(true);
  });

  it("does not claim the authenticated routes", () => {
    // If this returned true for these, the public handler would shadow the
    // secret-authenticated ones and hand them to anybody.
    expect(isPublicSalesRequest("/internal/mcp/content/generate-brief")).toBe(false);
    expect(isPublicSalesRequest("/master/chat")).toBe(false);
    expect(isPublicSalesRequest("/status")).toBe(false);
    expect(isPublicSalesRequest("/health")).toBe(false);
    expect(isPublicSalesRequest(undefined)).toBe(false);
  });
});

describe("WIDGET_SOURCE", () => {
  it("is syntactically valid JavaScript", () => {
    // It is a template string, so neither tsc nor the linter ever parses it. A
    // syntax error here would ship a dead widget to every site AA has published
    // and would only surface in a visitor's console. new Function parses
    // without executing.
    expect(() => new Function(WIDGET_SOURCE)).not.toThrow();
  });

  it("never references a secret or a provider endpoint", () => {
    // The widget talks only to AA. If a model host or key name ever appeared
    // here it would be in public page source on every client site.
    for (const forbidden of ["anthropic", "api.openai", "sk-", "ANTHROPIC", "service_role", "system_prompt", "guardrails"]) {
      expect(WIDGET_SOURCE).not.toContain(forbidden);
    }
  });

  it("reads its deployment id from the tag rather than hard-coding one", () => {
    expect(WIDGET_SOURCE).toContain("data-agent");
  });

  it("scopes itself in a shadow root so it cannot fight the page's CSS", () => {
    expect(WIDGET_SOURCE).toContain("attachShadow");
  });
});
