import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "./client-ip.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublicSales, isPublicSalesRequest, maxSalesTurnCostUsd, parsePath } from "./sales-route.js";
import { estimateCostUsd } from "../usage/cost.js";
import { WIDGET_SOURCE } from "./widget.js";

const provider = vi.hoisted(() => ({ create: vi.fn(), init: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {
  constructor(options: unknown) { provider.init(options); }
  messages = { create: provider.create };
} }));
beforeEach(() => { provider.create.mockReset(); provider.init.mockReset(); });

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

it("bounds one paid turn before provider work", () => {
  const reserve = maxSalesTurnCostUsd("claude-opus-5", "system", [
    { role: "user", content: "a short question" },
  ]);
  expect(reserve).not.toBeNull();
  expect(reserve!).toBeGreaterThan(estimateCostUsd("claude-opus-5", {
    inputTokens: 1_000, outputTokens: 1_024,
  }));
  expect(maxSalesTurnCostUsd("claude-opus-5", "x".repeat(140_000), [])).toBeNull();
});

it("charges the public quota before resolving a deployment or reading its message", async () => {
  const req = Readable.from([Buffer.from("{".repeat(20_000))]) as IncomingMessage;
  req.url = `/public/sales/v1/d/${"a".repeat(32)}/message`;
  req.method = "POST";
  req.headers = { origin: "https://client.example" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.4" } });
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: false, error: null }));
  const sb = { rpc } as unknown as SupabaseClient;
  const config = { publicIpSalt: "test-salt", trustedProxies: parseTrustedProxies(undefined) } as RuntimeConfig;
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await handlePublicSales(req, res, sb, config);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]?.[0]).toBe("admit_public_route_v6");
  expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
});

async function runWidgetTurn(options: {
  budget?: { allowed: boolean; reason: string; reservation_id: string | null };
  settlement?: { data: boolean | null; error: Error | null };
  providerFailure?: boolean;
} = {}) {
  if (options.providerFailure) provider.create.mockResolvedValue({ usage: null, content: [] });
  else provider.create.mockResolvedValue({
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "text", text: "We can help. We will follow up." },
      { type: "tool_use", name: "record_contact", input: {
        name: "Sam", email: "sam@example.test", summary: "Asked for a quote", qualified: true,
      } }],
  });
  const req = Readable.from([Buffer.from(JSON.stringify({
    message: "I agree to be contacted at sam@example.test about a quote.",
  }))]) as IncomingMessage;
  req.url = `/public/sales/v1/d/${"a".repeat(32)}/message`;
  req.method = "POST";
  req.headers = { origin: "https://client.example" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.4" } });
  const deployment = {
    deployment_id: "11111111-1111-4111-8111-111111111111",
    client_id: "22222222-2222-4222-8222-222222222222",
    sales_agent_id: "33333333-3333-4333-8333-333333333333",
    page_id: "44444444-4444-4444-8444-444444444444",
    allowed_origin: "https://client.example", greeting: "Hello",
    system_prompt: "Help the visitor", guardrails: "Be accurate", widget_config: {},
  };
  const order: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string) => {
    order.push(name);
    if (name === "admit_public_route_v6") return { data: true, error: null };
    if (name === "resolve_sales_deployment") return { data: [deployment], error: null };
    if (name === "reserve_sales_runtime_v6") return { data: [options.budget ?? { allowed: true, reason: "ok", reservation_id: "reserve-1" }], error: null };
    if (name === "settle_sales_runtime_v6") return options.settlement ?? { data: false, error: null };
    return { data: null, error: null };
  });
  const sb = {
    rpc,
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return { select: () => ({ single: async () => ({ data: { id: "conversation-1" }, error: null }) }) };
      },
      update: (_row: unknown) => ({ eq: async () => ({ error: null }) }),
    }),
  } as unknown as SupabaseClient;
  const config = {
    publicIpSalt: "test-salt", trustedProxies: parseTrustedProxies(undefined),
    model: "claude-opus-5", anthropicApiKey: "test-key", providerTimeoutMs: 60_000,
  } as RuntimeConfig;
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await handlePublicSales(req, res, sb, config);
  return { res, order, inserted, rpc };
}

it("reserves and settles a real widget turn before replying", async () => {
  const { res, order, inserted } = await runWidgetTurn();
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.init).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  expect(order.indexOf("reserve_sales_runtime_v6")).toBeLessThan(order.indexOf("settle_sales_runtime_v6"));
  expect(order.indexOf("settle_sales_runtime_v6")).toBeLessThan(order.indexOf("capture_sales_agent_lead"));
  expect(inserted).toContainEqual(expect.objectContaining({
    table: "sales_runtime_requests", outcome: "ok", reservation_id: "reserve-1",
  }));
});

it("never calls the provider when the shared paid budget refuses a turn", async () => {
  const { res, order } = await runWidgetTurn({ budget: {
    allowed: false, reason: "daily_ceiling", reservation_id: null,
  } });
  expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
  expect(provider.create).not.toHaveBeenCalled();
  expect(order).not.toContain("settle_sales_runtime_v6");
});

it("keeps the reserve held after an unusable provider response", async () => {
  const { res, order, inserted } = await runWidgetTurn({ providerFailure: true });
  expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
  expect(order).toContain("mark_sales_runtime_uncertain_v6");
  expect(order).not.toContain("settle_sales_runtime_v6");
  expect(inserted).toContainEqual(expect.objectContaining({
    table: "sales_runtime_requests", outcome: "error", reservation_id: "reserve-1",
  }));
});

it.each([
  [{ data: null, error: null }, "empty response"],
  [{ data: null, error: new Error("network outcome unknown") }, "RPC failure"],
] as const)("keeps the reserve held after settlement %s (%s)", async (settlement, _label) => {
  const { res, order } = await runWidgetTurn({ settlement });
  expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
  expect(order).toContain("mark_sales_runtime_uncertain_v6");
  expect(order).not.toContain("capture_sales_agent_lead");
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
