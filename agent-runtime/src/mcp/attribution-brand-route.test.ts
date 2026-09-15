import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { handleMcpAttribution } from "./attribution-route.js";
import { handleMcpBrand } from "./brand-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const SECRET = "test-only-service-credential";

function rpc(data: unknown, error: { code: string; message: string } | null = null) {
  return vi.fn(() => ({
    abortSignal: async () => ({ data, error }),
  }));
}

async function post(
  handler: typeof handleMcpAttribution,
  url: string,
  body: unknown,
  options: {
    headers?: Record<string, string | undefined>;
    rpc?: ReturnType<typeof rpc>;
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": "bot_marketing",
    "x-request-id": "request-1",
    "idempotency-key": "execution-1",
    "content-type": "application/json",
    ...options.headers,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
  req.method = "POST";
  (req as IncomingMessage).url = url;
  let status = 0;
  let jsonBody: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => {
      status = code;
    },
    setHeader: vi.fn(),
    end: (data: string) => {
      jsonBody = JSON.parse(data);
    },
  }) as unknown as ServerResponse;
  const rpcFn = options.rpc ?? rpc({ client_id: CLIENT });
  await handler(req, res, { rpc: rpcFn } as unknown as SupabaseClient, SECRET);
  return { status, body: jsonBody, rpc: rpcFn };
}

describe("Phase 16c Attribution and Brand HTTP", () => {
  it("empty funnel and empty content performance pass through", async () => {
    const funnel = await post(
      handleMcpAttribution,
      "/internal/mcp/attribution/get-conversion-funnel",
      { client_id: CLIENT },
      {
        rpc: rpc({
          client_id: CLIENT,
          projection: "acquisition_funnel_v1",
          days: 30,
          funnel: {
            leads: 0,
            conversations: 0,
            appointments: 0,
            sales: 0,
            lost: 0,
            pipeline_value: 0,
            sale_value: 0,
            cash_collected: 0,
            spend: 0,
            lead_to_sale_pct: null,
            cost_per_lead: null,
            return_on_spend: null,
          },
        }),
      },
    );
    expect(funnel.status).toBe(200);
    expect(funnel.body.funnel.leads).toBe(0);
    expect(funnel.body.funnel.lead_to_sale_pct).toBeNull();
    const content = await post(
      handleMcpAttribution,
      "/internal/mcp/attribution/get-content-performance",
      { client_id: CLIENT },
      { rpc: rpc({ client_id: CLIENT, projection: "content_attribution_v1", items: [] }) },
    );
    expect(content.status).toBe(200);
    expect(content.body.items).toEqual([]);
  });

  it("missing brand profile is found=false", async () => {
    const result = await post(
      handleMcpBrand,
      "/internal/mcp/brand/get-profile",
      { client_id: CLIENT },
      { rpc: rpc({ client_id: CLIENT, found: false, profile: null }) },
    );
    expect(result.status).toBe(200);
    expect(result.body.found).toBe(false);
    expect(result.body.profile).toBeNull();
  });

  it("client_forbidden does not invent numbers", async () => {
    const result = await post(
      handleMcpAttribution,
      "/internal/mcp/attribution/get-conversion-funnel",
      { client_id: CLIENT },
      { rpc: rpc(null, { code: "P0001", message: "client_forbidden" }) },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("client_forbidden");
  });
});
