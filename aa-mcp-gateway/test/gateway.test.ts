import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { z } from "zod";
import { Store } from "../src/audit/store.js";
import { ActionEngine } from "../src/policy/engine.js";
import { registry } from "../src/registry/tools.js";
import { authenticate } from "../src/auth/identity.js";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { grants } from "../src/policy/permissions.js";
import { config } from "../src/server/config.js";
import { createServer } from "../src/server/http.js";
import type { Adapter, Identity, Tool } from "../src/shared/types.js";
const client = "11111111-1111-4111-8111-111111111111";
const idea = "22222222-2222-4222-8222-222222222222";
const identity: Identity = { bot: "bot_production", clients: [client] };
const input = {
  client_id: client,
  idea_id: idea,
  idempotency_key: "test-key-001",
};
function fixture(adapter: Adapter = new AAApiAdapter(), discoverStubs = false) {
  const store = new Store(":memory:");
  return {
    store,
    engine: new ActionEngine(store, registry, adapter, discoverStubs),
  };
}
test("authentication rejects absent, malformed and unknown credentials", () => {
  const credentials = [{ ...identity, token: "a".repeat(40) }];
  for (const header of [undefined, "Basic aaa", "Bearer wrong"])
    assert.throws(() => authenticate(header, credentials));
  assert.deepEqual(
    authenticate(`Bearer ${"a".repeat(40)}`, credentials),
    identity,
  );
});
test("configuration validates credentials, distinct identities and HTTPS", () => {
  assert.throws(() => config({}));
  assert.throws(() =>
    config({
      BOT_CREDENTIALS_JSON: JSON.stringify([
        { ...identity, token: "a".repeat(40) },
      ]),
      REVIEWER_CREDENTIALS_JSON: JSON.stringify([
        { id: "alex", token: "a".repeat(40) },
      ]),
    }),
  );
});
test("all initial contracts have strict schemas, permissions and output metadata", () => {
  assert.equal(new Set(registry.map((t) => t.name)).size, registry.length);
  for (const t of registry) {
    assert.equal(t.audit, "required");
    assert.ok(t.permissions.length);
    assert.equal(
      t.input.safeParse({ client_id: client, execute_sql: "bad" }).success,
      false,
    );
  }
});
test("production discovery and execution enforce role and client scope", async () => {
  const { store, engine } = fixture();
  const discovered = engine.discover(identity);
  const names = discovered.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    "content.approve_asset",
    "content.create_repurpose_plan",
    "content.generate_brief",
    "content.get_brief",
    "content.get_idea",
    "content.get_production_status",
    "content.list_ideas",
    "content.request_approval",
    "content.request_revision",
    "content.select_idea",
    "workflow.assign_task",
    "workflow.complete_task",
    "workflow.create_approval",
    "workflow.create_task",
    "workflow.get_activity",
    "workflow.get_pending_approvals",
    "workflow.get_task",
    "workflow.list_tasks",
  ]);
  assert.ok(discovered.every((t) => t.implementation === "real"));
  assert.ok(!names.includes("content.generate_ideas"));
  assert.ok(!names.includes("content.queue_distribution"));
  assert.ok(!names.includes("pipeline.update_stage"));
  assert.ok(!names.includes("workflow.record_decision"));
  for (const t of registry.filter((tool) => tool.implementation === "stub"))
    assert.ok(!names.includes(t.name));
  assert.equal(
    (await engine.call(identity, "pipeline.update_stage", input)).status,
    "rejected",
  );
  assert.equal(
    (
      await engine.call(
        { ...identity, clients: [] },
        "content.generate_brief",
        input,
      )
    ).status,
    "rejected",
  );
  store.close();
});
test("Phase 9b: idea/asset decide are bot_production only, even with a wildcard content.* grant", () => {
  const { store, engine } = fixture(new AAApiAdapter(), true);
  const marketing: Identity = {
    bot: "bot_marketing",
    clients: [client],
    permissions: ["content.*"],
  };
  const marketingNames = engine.discover(marketing).map((t) => t.name);
  assert.ok(!marketingNames.includes("content.select_idea"));
  assert.ok(!marketingNames.includes("content.approve_asset"));
  const productionNames = engine.discover(identity).map((t) => t.name);
  assert.ok(productionNames.includes("content.select_idea"));
  assert.ok(productionNames.includes("content.approve_asset"));
  store.close();
});
test("MCP_DISCOVER_STUBS exposes permitted stubs; default call rejects stub names", async () => {
  const hidden = fixture();
  const defaultNames = hidden.engine.discover(identity).map((t) => t.name);
  assert.ok(defaultNames.includes("content.generate_brief"));
  assert.ok(defaultNames.includes("content.list_ideas"));
  assert.ok(!defaultNames.includes("content.generate_ideas"));
  const denied = await hidden.engine.call(identity, "content.generate_ideas", {
    client_id: client,
    idempotency_key: "stub-ideas-001",
  });
  assert.equal(denied.status, "rejected");
  assert.equal(denied.message, "Tool unavailable or unauthorized.");
  hidden.store.close();
  const shown = fixture(new AAApiAdapter(), true);
  const stubNames = shown.engine.discover(identity).map((t) => t.name);
  assert.ok(stubNames.includes("content.generate_brief"));
  assert.ok(stubNames.includes("content.list_ideas"));
  assert.ok(stubNames.includes("content.generate_ideas"));
  // Phase 10 realized queue_distribution for bot_distribution only; it is
  // hard-denied for bot_production (see permissions.ts) even under
  // MCP_DISCOVER_STUBS=true. content.get_performance is still a genuine stub.
  assert.ok(!stubNames.includes("content.queue_distribution"));
  assert.ok(stubNames.includes("content.get_performance"));
  assert.ok(!stubNames.includes("pipeline.update_stage"));
  assert.ok(!stubNames.includes("workflow.record_decision"));
  assert.equal(
    (
      await shown.engine.call(identity, "content.generate_ideas", {
        client_id: client,
        idempotency_key: "stub-ideas-001",
      })
    ).status,
    "not_implemented",
  );
  shown.store.close();
});
test("input validation rejects missing business identifier and unknown keys", async () => {
  const { store, engine } = fixture();
  assert.equal(
    (
      await engine.call(identity, "content.generate_brief", {
        client_id: client,
      })
    ).status,
    "rejected",
  );
  assert.equal(
    (
      await engine.call(identity, "content.generate_brief", {
        ...input,
        approved: true,
      })
    ).status,
    "rejected",
  );
  store.close();
});
test("Production Manager → ContentService → adapter → structured receipt and redacted audit", async () => {
  let calls = 0;
  const { store, engine } = fixture({
    async execute(t, i, c) {
      calls++;
      assert.equal(c.bot, identity.bot);
      assert.equal(i.idea_id, idea);
      return {
        status: "accepted",
        capability: t.name,
        data: { job_id: idea, client_id: client },
      };
    },
  });
  const result = await engine.call(identity, "content.generate_brief", input);
  assert.equal(result.status, "accepted");
  assert.equal(calls, 1);
  assert.equal(
    (await engine.call(identity, "content.generate_brief", input)).status,
    "accepted",
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await engine.call(identity, "content.generate_brief", {
        ...input,
        idea_id: client,
      })
    ).status,
    "rejected",
  );
  const audit = store.activity(client, identity.bot, 100);
  assert.ok(audit.length >= 3);
  assert.ok(!JSON.stringify(audit).includes(input.idempotency_key));
  store.close();
});
test("safe read, safe write, pending approval and activity are real control actions", async () => {
  const { store, engine } = fixture();
  const r = await engine.call(identity, "workflow.create_approval", {
    client_id: client,
    idempotency_key: "approval-key",
    summary: "Review the production plan",
  });
  assert.equal(r.status, "approval_required");
  const list = await engine.call(identity, "workflow.get_pending_approvals", {
    client_id: client,
  });
  assert.equal(list.status, "completed");
  assert.equal((list.data!.approvals as any[]).length, 1);
  assert.equal(
    (
      await engine.call(identity, "workflow.get_activity", {
        client_id: client,
      })
    ).status,
    "completed",
  );
  store.close();
});
test("stub adapters are honest; adapter errors are safe and never auto-retried", async () => {
  const f = fixture();
  assert.equal(
    (await f.engine.call(identity, "content.generate_brief", input)).status,
    "not_implemented",
  );
  f.store.close();
  let calls = 0;
  const { store, engine } = fixture({
    async execute() {
      calls++;
      throw new Error("SECRET downstream error");
    },
  });
  const r = await engine.call(identity, "content.generate_brief", input);
  assert.equal(r.status, "failed");
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  await engine.call(identity, "content.generate_brief", input);
  assert.equal(calls, 1);
  store.close();
});
test("Finance critical payment creates approval and cannot execute before human decision", async () => {
  let calls = 0;
  const store = new Store(":memory:");
  const critical: Tool = {
    ...registry.find((t) => t.name === "content.generate_brief")!,
    name: "finance.execute_payment",
    domain: "finance",
    permissions: ["finance.execute_payment"],
    risk: "CRITICAL",
    approval: false,
    input: z
      .object({
        client_id: z.string().uuid(),
        idempotency_key: z.string().min(8),
      })
      .strict(),
  };
  const engine = new ActionEngine(store, [...registry, critical], {
    async execute(t) {
      calls++;
      return { status: "completed", capability: t.name };
    },
  });
  const finance: Identity = { bot: "bot_finance", clients: [client] };
  grants.bot_finance.push("finance.execute_payment");
  try {
    const r = await engine.call(finance, critical.name, {
      client_id: client,
      idempotency_key: "payment-key",
    });
    assert.equal(r.status, "approval_required");
    assert.equal(calls, 0);
    await assert.rejects(() =>
      engine.executeApproval(r.approval_id!, [finance]),
    );
    engine.decide(r.approval_id!, "human_alex", "approved");
    const executed = await engine.executeApproval(r.approval_id!, [finance]);
    assert.equal(executed.status, "completed");
    assert.equal(calls, 1);
    await assert.rejects(() =>
      engine.executeApproval(r.approval_id!, [finance]),
    );
    assert.equal(calls, 1);
  } finally {
    grants.bot_finance.pop();
    store.close();
  }
});
test("approval rejection, expiration and revoked scope block execution", async () => {
  // content.queue_distribution left the gateway's HIGH-risk approval gate in
  // Phase 10 (now MEDIUM, AA-RPC-only, bot_distribution only); pipeline.record_sale
  // stays in that gate, so it now exercises this approval-lifecycle machinery.
  const salesOps: Identity = { bot: "bot_sales_ops", clients: [client] };
  const { store, engine } = fixture(new AAApiAdapter(), true);
  for (const mode of ["rejected", "expired", "revoked"]) {
    const r = await engine.call(salesOps, "pipeline.record_sale", {
      client_id: client,
      idempotency_key: `approval-${mode}`,
      lead_id: idea,
    });
    if (mode === "rejected") {
      engine.decide(r.approval_id!, "human", "rejected", "Needs changes");
      await assert.rejects(() =>
        engine.executeApproval(r.approval_id!, [salesOps]),
      );
    } else if (mode === "expired") {
      const a = store.getApproval(r.approval_id!);
      a.expires_at = new Date(0).toISOString();
      store.approval(a);
      assert.equal(
        engine.decide(r.approval_id!, "human", "approved").status,
        "expired",
      );
    } else {
      engine.decide(r.approval_id!, "human", "approved");
      assert.equal(
        (
          await engine.executeApproval(r.approval_id!, [
            { ...salesOps, clients: [] },
          ])
        ).status,
        "rejected",
      );
    }
  }
  store.close();
});
test("concurrent idempotency reservation prevents duplicate adapter invocation", async () => {
  let release!: () => void;
  let calls = 0;
  const { store, engine } = fixture({
    async execute(t) {
      calls++;
      await new Promise<void>((r) => (release = r));
      return { status: "completed", capability: t.name };
    },
  });
  const first = engine.call(identity, "content.generate_brief", input);
  assert.equal(
    (await engine.call(identity, "content.generate_brief", input)).status,
    "indeterminate",
  );
  release();
  await first;
  assert.equal(calls, 1);
  store.close();
});
test("HTTP MCP discovery/call and human-only approval boundary", async () => {
  const { store, engine } = fixture();
  const c = config({
    BOT_CREDENTIALS_JSON: JSON.stringify([
      { ...identity, token: "a".repeat(40) },
    ]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: "b".repeat(40) },
    ]),
  });
  const server = createServer(c, engine);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  c.PUBLIC_ORIGIN = `http://127.0.0.1:${address.port}`;
  const headers = {
    authorization: `Bearer ${"a".repeat(40)}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  try {
    const health = await fetch(c.PUBLIC_ORIGIN + "/health", { headers: { host: "healthcheck.railway.app" } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(
      (
        await fetch(c.PUBLIC_ORIGIN + "/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const response = await fetch(c.PUBLIC_ORIGIN + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(response.status, 200);
    const list: any = await response.json();
    const listed = list.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(listed, [
      "content.approve_asset",
      "content.create_repurpose_plan",
      "content.generate_brief",
      "content.get_brief",
      "content.get_idea",
      "content.get_production_status",
      "content.list_ideas",
      "content.request_approval",
      "content.request_revision",
      "content.select_idea",
      "workflow.assign_task",
      "workflow.complete_task",
      "workflow.create_approval",
      "workflow.create_task",
      "workflow.get_activity",
      "workflow.get_pending_approvals",
      "workflow.get_task",
      "workflow.list_tasks",
    ]);
    assert.ok(!listed.includes("content.generate_ideas"));
    assert.ok(!listed.includes("workflow.record_decision"));
    const call = await fetch(c.PUBLIC_ORIGIN + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "content.generate_brief", arguments: input },
      }),
    });
    const body: any = await call.json();
    assert.equal(body.result.structuredContent.status, "not_implemented");
    assert.equal(
      (await fetch(c.PUBLIC_ORIGIN + "/admin/approvals", { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(c.PUBLIC_ORIGIN + "/admin/approvals", {
          headers: { authorization: `Bearer ${"b".repeat(40)}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(c.PUBLIC_ORIGIN + "/mcp", {
          method: "POST",
          headers: { ...headers, origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    server.close();
    await once(server, "close");
    store.close();
  }
});

test("control receipts and approvals survive a process/store restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "aa-gateway-"));
  const path = join(dir, "control.sqlite");
  let store = new Store(path);
  try {
    let engine = new ActionEngine(store, registry, new AAApiAdapter());
    const r = await engine.call(identity, "workflow.create_approval", {
      client_id: client,
      idempotency_key: "durable-key",
      summary: "Review",
    });
    store.close();
    store = new Store(path);
    engine = new ActionEngine(store, registry, new AAApiAdapter());
    const replay = await engine.call(identity, "workflow.create_approval", {
      client_id: client,
      idempotency_key: "durable-key",
      summary: "Review",
    });
    assert.equal(replay.approval_id, r.approval_id);
    assert.equal(store.approvals().length, 1);
    assert.ok(store.activity(client, identity.bot, 25).length > 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed AA API adapter enforces business route, execution key and client response", async () => {
  const { createServer: mockServer } = await import("node:http");
  let responseClient = client;
  let received: any;
  const upstream = mockServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ client_id: responseClient, job_id: idea }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address() as any;
  const { store, engine } = fixture(
    new AAApiAdapter({
      url: `http://127.0.0.1:${address.port}`,
      token: "c".repeat(40),
    }),
  );
  try {
    assert.equal(
      (await engine.call(identity, "content.generate_brief", input)).status,
      "accepted",
    );
    assert.equal(received.url, "/internal/mcp/content/generate-brief");
    assert.deepEqual(received.body, { client_id: client, idea_id: idea });
    assert.equal(received.headers["x-aa-bot-id"], identity.bot);
    assert.match(received.headers["idempotency-key"], /^[a-f0-9]{64}$/);
    responseClient = idea;
    assert.equal(
      (
        await engine.call(identity, "content.generate_brief", {
          ...input,
          idempotency_key: "new-client-check",
        })
      ).status,
      "failed",
    );
  } finally {
    upstream.close();
    await once(upstream, "close");
    store.close();
  }
});

test("Railway settings require public binding, origin and persistent path", () => {
  const credentials = {
    BOT_CREDENTIALS_JSON: JSON.stringify([{ ...identity, token: "a".repeat(40) }]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([{ id: "reviewer", token: "b".repeat(40) }]),
  };
  assert.equal(config(credentials).PORT, 3100);
  assert.equal(config(credentials).MCP_DISCOVER_STUBS, false);
  assert.equal(
    config({ ...credentials, MCP_DISCOVER_STUBS: "true" }).MCP_DISCOVER_STUBS,
    true,
  );
  assert.equal(
    config({ ...credentials, MCP_DISCOVER_STUBS: "false" }).MCP_DISCOVER_STUBS,
    false,
  );
  const hosted = { ...credentials, RAILWAY_ENVIRONMENT_ID: "test", PUBLIC_ORIGIN: "https://gateway.example.com", DATABASE_PATH: "/data/gateway.sqlite" };
  assert.equal(config({ ...hosted, PORT: "4567" }).PORT, 4567);
  assert.equal(config(hosted).HOST, "0.0.0.0");
  for (const PORT of ["", " ", "0", "65536", "123abc", "12.5"]) assert.throws(() => config({ ...hosted, PORT }));
  assert.throws(() => config({ ...hosted, HOST: "127.0.0.1" }));
  assert.throws(() => config({ ...hosted, PUBLIC_ORIGIN: undefined }));
  assert.throws(() => config({ ...hosted, DATABASE_PATH: "./data/gateway.sqlite" }));
});
