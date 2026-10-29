import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/audit/store.js";
import { ActionEngine } from "../src/policy/engine.js";
import { registry } from "../src/registry/tools.js";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { config } from "../src/server/config.js";
import { createServer } from "../src/server/http.js";

test("service-authenticated gateway readiness reveals a full commit but no credentials", async () => {
  const secret = "s".repeat(40);
  const sha = "a".repeat(40);
  const previousSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = sha;
  const store = new Store(":memory:");
  const engine = new ActionEngine(store, registry, new AAApiAdapter());
  const c = config({
    PUBLIC_ORIGIN: "http://127.0.0.1:3100",
    BOT_CREDENTIALS_JSON: JSON.stringify([{
      bot: "bot_production", clients: ["11111111-1111-4111-8111-111111111111"],
      token: "b".repeat(40),
    }]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([{ id: "human", token: "h".repeat(40) }]),
    AA_INTERNAL_API_URL: "http://localhost:8787",
    AA_MCP_SERVICE_SECRET: secret,
  });
  const server = createServer(c, engine);
  async function request(authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      let status = 0;
      const req = {
        url: "/internal/readiness", method: "GET",
        headers: { host: "127.0.0.1:3100", authorization },
        socket: { remoteAddress: "127.0.0.1" },
      };
      const res = {
        headersSent: false,
        setHeader() {},
        writeHead(code: number) { status = code; },
        end(body: string) { resolve({ status, body: JSON.parse(body) as Record<string, unknown> }); },
      };
      server.emit("request", req, res);
    });
  }
  try {
    const denied = await request();
    assert.equal(denied.status, 401);
    const allowed = await request(`Bearer ${secret}`);
    assert.equal(allowed.status, 200);
    const body = allowed.body;
    assert.equal(body.sha, sha);
    assert.deepEqual(body.configured, { aaInternalApi: true, botAuthMode: "dual" });
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes("h".repeat(40)), false);
  } finally {
    store.close();
    if (previousSha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = previousSha;
  }
});
