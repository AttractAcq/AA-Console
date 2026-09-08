import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { config } from "../src/server/config.js";
const client = "11111111-1111-4111-8111-111111111111";
const idea = "22222222-2222-4222-8222-222222222222";
const identity = { bot: "bot_production" as const, clients: [client] };
const input = {
  client_id: client,
  idea_id: idea,
  idempotency_key: "brief-test-001",
};
const tool = registry.find((t) => t.name === "content.generate_brief")!;
const context = {
  ...identity,
  request_id: "request-001",
  execution_id: "execution-001",
};
async function fixture(t: any, status: number, body: unknown, delay = false) {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: JSON.parse(raw),
    });
    if (delay) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const adapter = new AAApiAdapter({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "service-secret",
    timeoutMs: delay ? 50 : 1000,
  });
  return { adapter, received };
}
for (const status of [202, 200])
  test(`AA ${status} succeeds and forwards exact identities; gateway replay is durable`, async (t) => {
    const { adapter, received } = await fixture(t, status, {
      job_id: idea,
      client_id: client,
    });
    const store = new Store(":memory:");
    t.after(() => store.close());
    const engine = new ActionEngine(store, registry, adapter);
    const result = await engine.call(
      identity,
      tool.name,
      input,
      context.request_id,
    );
    assert.equal(result.status, "accepted");
    assert.deepEqual(result.data, { job_id: idea, client_id: client });
    const execution = createHash("sha256")
      .update(
        JSON.stringify([
          identity.bot,
          tool.name,
          client,
          input.idempotency_key,
          "initial",
        ]),
      )
      .digest("hex");
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].url, "/internal/mcp/content/generate-brief");
    assert.equal(received[0].headers.authorization, "Bearer service-secret");
    assert.equal(received[0].headers["x-aa-bot-id"], identity.bot);
    assert.equal(received[0].headers["x-request-id"], context.request_id);
    assert.equal(received[0].headers["idempotency-key"], execution);
    assert.deepEqual(received[0].body, { client_id: client, idea_id: idea });
    assert.equal(
      (await engine.call(identity, tool.name, input)).status,
      "accepted",
    );
    assert.equal(received.length, 1);
    assert.ok(
      store
        .activity(client, identity.bot, 10)
        .some(
          (a) =>
            a.request_id === context.request_id &&
            a.execution_result === "accepted",
        ),
    );
  });
for (const [status, code] of [
  [401, "unauthorized"],
  [403, "invalid_bot"],
  [400, "invalid_request"],
  [404, "idea_not_found"],
  [403, "client_mismatch"],
  [403, "client_forbidden"],
  [409, "invalid_idea_status"],
  [409, "idempotency_conflict"],
  [503, "brief_agent_unavailable"],
  [500, "queue_failure"],
  [500, "internal_error"],
] as const)
  test(`AA ${status} preserves ${code} in result and audit`, async (t) => {
    const { adapter } = await fixture(t, status, {
      error: { code, message: "SECRET" },
    });
    const store = new Store(":memory:");
    t.after(() => store.close());
    const result = await new ActionEngine(store, registry, adapter).call(
      identity,
      tool.name,
      input,
    );
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, { code, upstream_status: status });
    assert.equal(store.activity(client, identity.bot, 10)[0].error, code);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  });
test("string AA error and HTTP fallback are structured", async (t) => {
  for (const body of [{ error: "queue_failure" }, "not json"]) {
    const { adapter } = await fixture(t, 500, body);
    assert.equal(
      (await adapter.execute(tool, input, context)).error?.code,
      typeof body === "string" ? "internal_error" : "queue_failure",
    );
  }
});
test("timeout is bounded", async (t) => {
  const { adapter } = await fixture(t, 202, {}, true);
  assert.equal(
    (await adapter.execute(tool, input, context)).error?.code,
    "upstream_timeout",
  );
});
for (const body of [
  "not json",
  {},
  { job_id: "bad", client_id: client },
  { job_id: idea, client_id: idea },
  "x".repeat(17000),
])
  test("malformed AA success fails safely", async (t) => {
    const { adapter } = await fixture(t, 202, body);
    assert.equal(
      (await adapter.execute(tool, input, context)).error?.code,
      "malformed_response",
    );
  });
test("invalid identifiers do not reach AA", async (t) => {
  const { adapter, received } = await fixture(t, 202, {});
  for (const key of ["client_id", "idea_id"]) {
    assert.equal(
      (await adapter.execute(tool, { ...input, [key]: "bad" }, context)).error
        ?.code,
      "invalid_request",
    );
    const store = new Store(":memory:");
    assert.equal(
      (
        await new ActionEngine(store, registry, adapter).call(
          identity,
          tool.name,
          { ...input, [key]: "bad" },
        )
      ).status,
      "rejected",
    );
    store.close();
  }
  assert.equal(received.length, 0);
});
test("new AA environment pair is validated", () => {
  const env = {
    BOT_CREDENTIALS_JSON: JSON.stringify([
      { ...identity, token: "a".repeat(40) },
    ]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "reviewer", token: "b".repeat(40) },
    ]),
  };
  assert.throws(() =>
    config({ ...env, AA_INTERNAL_API_URL: "https://aa.example.com" }),
  );
  assert.throws(() =>
    config({ ...env, AA_MCP_SERVICE_SECRET: "c".repeat(40) }),
  );
  assert.throws(() =>
    config({
      ...env,
      AA_INTERNAL_API_URL: "http://aa.example.com",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }),
  );
  assert.throws(() =>
    config({
      ...env,
      AA_INTERNAL_API_URL: "http://evil.example.com.railway.internal.evil.com",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }),
  );
  assert.equal(
    config({
      ...env,
      AA_INTERNAL_API_URL: "https://aa.example.com",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }).AA_INTERNAL_API_URL,
    "https://aa.example.com",
  );
  assert.equal(
    config({
      ...env,
      AA_INTERNAL_API_URL: "http://aa-console.railway.internal:8080",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }).AA_INTERNAL_API_URL,
    "http://aa-console.railway.internal:8080",
  );
  assert.equal(tool.implementation, "real");
});
