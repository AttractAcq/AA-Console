import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { handleMcpSites } from "./sites-mcp-route.js";
import type { RuntimeConfig } from "../config.js";
import { publishPage } from "../sites/provision.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PAGE = "33333333-3333-4333-8333-333333333333";
const GATEWAY_APPROVAL = "44444444-4444-4444-8444-444444444444";
const GATEWAY_CLAIM = "55555555-5555-4555-8555-555555555555";
const SECRET = "test-only-service-credential";

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    githubAppId: "123",
    githubAppPrivateKey: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    githubInstallationId: "1",
    githubSitesOrg: "attractacq",
    publicRuntimeBase: "https://runtime.attractacq.com",
    ...overrides,
  } as RuntimeConfig;
}

function rpc(data: unknown = { client_id: CLIENT, authorized: true }, error: { code: string; message: string } | null = null) {
  return vi.fn(() => ({
    abortSignal: async () => ({ data, error }),
  }));
}

async function call(
  path: "provision" | "publish-page",
  body: unknown,
  options: {
    headers?: Record<string, string | undefined>;
    secret?: string | null;
    authorize?: ReturnType<typeof rpc>;
    provisionSite?: (...args: any[]) => Promise<any>;
    publishPage?: typeof publishPage;
    config?: RuntimeConfig;
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": "bot_marketing",
    "x-request-id": "request-1",
    "idempotency-key": "execution-1",
    "x-aa-gateway-approval-id": GATEWAY_APPROVAL,
    "x-aa-gateway-execution-key": GATEWAY_CLAIM,
    "content-type": "application/json",
    ...options.headers,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
  req.method = "POST";
  (req as IncomingMessage).url = `/internal/mcp/sites/${path}`;
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
  const rpcFn = options.authorize ?? rpc();
  await handleMcpSites(
    req,
    res,
    { rpc: rpcFn } as unknown as SupabaseClient,
    options.secret === undefined ? SECRET : options.secret,
    options.config ?? config(),
    {
      provisionSite: options.provisionSite,
      publishPage: options.publishPage,
    },
  );
  return { status, body: jsonBody, rpc: rpcFn };
}

describe("Phase 16c Sites MCP HTTP", () => {
  it("refuses a site write without the central gateway claim identity", async () => {
    const provisionSite = vi.fn();
    const result = await call("provision", { client_id: CLIENT, repo: "harbour" }, {
      headers: { "x-aa-gateway-approval-id": undefined }, provisionSite,
    });
    expect(result.status).toBe(400);
    expect(provisionSite).not.toHaveBeenCalled();
    expect(result.rpc).not.toHaveBeenCalled();
  });

  it("refuses a stale or mismatched central claim before GitHub", async () => {
    const provisionSite = vi.fn();
    const check = vi.fn((name: string) => ({ abortSignal: async () => ({
      data: name === "mcp_sites_authorize" ? { client_id: CLIENT, authorized: true } : null,
      error: name === "assert_gateway_sites_prewrite_v6"
        ? { code: "42501", message: "Approval changed" } : null,
    }) }));
    const result = await call("provision", { client_id: CLIENT, repo: "harbour" }, {
      authorize: check as unknown as ReturnType<typeof rpc>, provisionSite,
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("approval_required");
    expect(provisionSite).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith("assert_gateway_sites_prewrite_v6", {
      p_approval_id: GATEWAY_APPROVAL, p_execution_key: GATEWAY_CLAIM,
      p_client_id: CLIENT, p_bot_id: "bot_marketing", p_tool: "sites.provision",
      p_target: "harbour", p_provider_org: "attractacq",
    });
  });

  it("rechecks the claim immediately before a GitHub request and refuses a revoked claim", async () => {
    let checks = 0;
    const check = vi.fn((name: string) => ({ abortSignal: async () => {
      if (name === "assert_gateway_sites_prewrite_v6") checks++;
      return { data: { client_id: CLIENT, authorized: true },
        error: name === "assert_gateway_sites_prewrite_v6" && checks > 1
          ? { code: "42501", message: "Revoked" } : null };
    } }));
    const externalFetch = vi.spyOn(globalThis, "fetch");
    const provisionSite = vi.fn(async (_store, _app, _site, _request, deps) => {
      await deps.fetchImpl("https://api.github.example.invalid/repos");
      throw new Error("Unexpected provider call");
    });
    try {
      const result = await call("provision", { client_id: CLIENT, repo: "harbour" }, {
        authorize: check as unknown as ReturnType<typeof rpc>, provisionSite,
      });
      expect(result.status).toBe(409);
      expect(result.body.error.code).toBe("approval_required");
      expect(checks).toBe(2);
      expect(externalFetch).not.toHaveBeenCalled();
    } finally { externalFetch.mockRestore(); }
  });

  it("engineering is forbidden before GitHub or SQL authorize", async () => {
    const provisionSite = vi.fn();
    const result = await call(
      "provision",
      { client_id: CLIENT, repo: "harbour" },
      { headers: { "x-aa-bot-id": "bot_engineering" }, provisionSite },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("bot_forbidden");
    expect(provisionSite).not.toHaveBeenCalled();
    expect(result.rpc).not.toHaveBeenCalled();
  });

  it("missing GitHub app config is github_unconfigured after authorize", async () => {
    const result = await call(
      "provision",
      { client_id: CLIENT, repo: "harbour" },
      {
        config: config({ githubAppId: null, githubAppPrivateKey: null }),
        provisionSite: vi.fn(),
      },
    );
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("github_unconfigured");
    expect(result.rpc).toHaveBeenCalled();
  });

  it("provision calls the same orchestration as admin after SQL authorize", async () => {
    const provisionSite = vi.fn(async () => ({
      created: true,
      repo: { owner: "attractacq", repo: "harbour", status: "ready" },
      pagesUrl: "https://attractacq.github.io/harbour/",
    }));
    const result = await call(
      "provision",
      { client_id: CLIENT, repo: "harbour" },
      { provisionSite },
    );
    expect(result.status).toBe(200);
    expect(result.body.repo).toBe("harbour");
    expect(result.body.pages_url).toBe("https://attractacq.github.io/harbour/");
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE KEY|githubAppPrivateKey/);
    expect(provisionSite).toHaveBeenCalledOnce();
  });

  it("publish_page uses publishPage (injectWidget path) and never returns keys", async () => {
    const runPublish = vi.fn(async () => ({
      url: "https://attractacq.github.io/harbour/page/",
      commit: "deadbeef",
      changed: true,
    }));
    const result = await call(
      "publish-page",
      { client_id: CLIENT, page_id: PAGE },
      {
        authorize: rpc({ client_id: CLIENT, page_id: PAGE, authorized: true }),
        publishPage: runPublish as unknown as typeof publishPage,
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.commit).toBe("deadbeef");
    expect(runPublish).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.body)).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("SQL page_not_found does not call GitHub", async () => {
    const runPublish = vi.fn();
    const result = await call(
      "publish-page",
      { client_id: CLIENT, page_id: PAGE },
      {
        authorize: rpc(null, { code: "P0001", message: "page_not_found" }),
        publishPage: runPublish as unknown as typeof publishPage,
      },
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("page_not_found");
    expect(runPublish).not.toHaveBeenCalled();
  });
});
