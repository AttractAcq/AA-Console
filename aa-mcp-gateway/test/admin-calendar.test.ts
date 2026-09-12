import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as mockServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { adminCalendar } from "../src/onboarding/admin-calendar.js";
import { allowed, grants } from "../src/policy/permissions.js";
import { bots } from "../src/shared/types.js";
import {
  BotAuthenticator,
  type AaResolveResult,
} from "../src/auth/identity.js";
import { assertAdminDiscovery, runAdminGate } from "../scripts/admin-gate.js";
import { createServer } from "../src/server/http.js";
import { config } from "../src/server/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  id = "33333333-3333-4333-8333-333333333333";
const identity = { bot: "bot_admin" as const, clients: [client] };
const input = {
  client_id: client,
  title: "Fixture",
  event_type: "meeting",
  notes: null,
  starts_at: "2026-10-01T10:00:00Z",
  ends_at: "2026-10-01T11:00:00Z",
  idempotency_key: "admin-fixture-key",
};
const event = {
  id,
  client_id: client,
  title: "Fixture",
  notes: null,
  event_type: "meeting",
  starts_at: input.starts_at,
  ends_at: input.ends_at,
  status: "scheduled",
  version: 1,
  created_by_bot: "bot_admin",
  updated_by_bot: "bot_admin",
  created_at: input.starts_at,
  updated_at: input.starts_at,
};
function engine(t: any, adapter: any = new AAApiAdapter()) {
  const e = new ActionEngine(new Store(":memory:"), registry, adapter);
  t.after(() => e.store.close());
  return e;
}
async function mockAa(
  t: any,
  handler: (body: any, path: string, headers: any) => any,
) {
  const seen: any[] = [];
  const server = mockServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url, body, headers: req.headers });
    const result = handler(body, req.url!, req.headers);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    seen,
    adapter: new AAApiAdapter({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "test-only-service-credential",
    }),
  };
}
test("Admin exact discovery equality is 15 and all 11 existing names remain real", (t) => {
  const e = engine(t);
  assertAdminDiscovery(e.discover(identity).map((t) => t.name));
  assert.equal(registry.length, 89);
  for (const name of adminCalendar.grants)
    assert.equal(registry.find((t) => t.name === name)?.implementation, "real");
  for (const name of [
    "sales_agents.deploy",
    "campaign.create",
    "content.generate_ideas",
  ])
    assert.equal(registry.find((t) => t.name === name)?.implementation, "stub");
});
test("Admin ceiling rejects broad grants; every other bot denies admin tools", (t) => {
  const e = engine(t);
  const broad = {
    ...identity,
    permissions: registry.map((t) => `${t.domain}.*`),
  };
  assertAdminDiscovery(e.discover(broad).map((t) => t.name));
  for (const bot of bots.filter((b) => b !== "bot_admin"))
    for (const tool of registry.filter((t) => t.domain === "admin"))
      assert.equal(
        allowed({ bot, clients: [client], permissions: ["admin.*"] }, tool),
        false,
      );
});
test("forbidden tools, record_decision and cross-client inputs never reach adapter", async (t) => {
  let calls = 0;
  const e = engine(t, {
    execute: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  for (const tool of registry.filter(
    (t) => !adminCalendar.grants.some((n) => n === t.name),
  ))
    assert.equal(
      (
        await e.call(
          { ...identity, permissions: registry.map((t) => `${t.domain}.*`) },
          tool.name,
          {},
        )
      ).status,
      "rejected",
    );
  for (const name of [
    "admin.list_events",
    "admin.get_event",
    "admin.create_event",
    "admin.update_event",
  ]) {
    const args = name.endsWith("list_events")
      ? { client_id: other }
      : name.endsWith("get_event")
        ? { client_id: other, event_id: id }
        : name.endsWith("create_event")
          ? { ...input, client_id: other }
          : {
              client_id: other,
              event_id: id,
              title: "Fixture",
              notes: null,
              starts_at: input.starts_at,
              ends_at: input.ends_at,
              status: "cancelled",
              expected_version: 1,
              idempotency_key: "test-key-12",
            };
    assert.equal(
      (await e.call(identity, name, args)).message,
      "Client scope denied.",
    );
  }
  assert.equal(calls, 0);
});
test("Admin adapter routes all four tools with exact fields and correlation", async (t) => {
  const { adapter, seen } = await mockAa(t, (body, path) => ({
    body: path.endsWith("list-events")
      ? { client_id: client, events: [event], next_cursor: null }
      : { client_id: client, event },
  }));
  const e = engine(t, adapter);
  const cases = [
    ["admin.list_events", { client_id: client }],
    ["admin.get_event", { client_id: client, event_id: id }],
    ["admin.create_event", input],
    [
      "admin.update_event",
      {
        client_id: client,
        event_id: id,
        title: "Fixture",
        notes: null,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        status: "cancelled",
        expected_version: 1,
        idempotency_key: "update-key-12",
      },
    ],
  ] as const;
  for (const [name, args] of cases)
    assert.equal((await e.call(identity, name, args)).status, "completed");
  assert.deepEqual(
    seen.map((x) => x.path),
    [
      "/internal/mcp/admin/list-events",
      "/internal/mcp/admin/get-event",
      "/internal/mcp/admin/create-event",
      "/internal/mcp/admin/update-event",
    ],
  );
  for (const x of seen) {
    assert.equal(x.headers["x-aa-bot-id"], "bot_admin");
    assert.ok(x.headers["x-request-id"]);
    assert.ok(x.headers["idempotency-key"]);
    assert.equal(x.body.idempotency_key, undefined);
  }
});
test("Admin replay reauthorizes in backend; same execution key, no cached success", async (t) => {
  let permitted = true;
  const { adapter, seen } = await mockAa(t, () =>
    permitted
      ? { body: { client_id: client, event, replayed: false } }
      : { status: 403, body: { error: { code: "client_forbidden" } } },
  );
  const e = engine(t, adapter);
  assert.equal(
    (await e.call(identity, "admin.create_event", input)).status,
    "completed",
  );
  permitted = false;
  const replay = await e.call(identity, "admin.create_event", input);
  assert.equal(replay.error?.code, "client_forbidden");
  assert.equal(seen.length, 2);
  assert.equal(
    seen[0].headers["idempotency-key"],
    seen[1].headers["idempotency-key"],
  );
  assert.equal(
    (
      await e.call(identity, "admin.create_event", {
        ...input,
        title: "Changed",
      })
    ).status,
    "rejected",
  );
  assert.equal(seen.length, 2);
  const audit = e.store.activity(client, "bot_admin", 10);
  assert.ok(
    audit.some((a) => a.execution_id === seen[0].headers["idempotency-key"]),
  );
});
test("adapter rejects nested cross-client or mismatched event and malformed replies", async (t) => {
  let raw: any = { client_id: client, event: { ...event, client_id: other } };
  const { adapter } = await mockAa(t, () => ({ body: raw }));
  const e = engine(t, adapter);
  for (const value of [
    raw,
    { client_id: client, event: { ...event, id: other } },
    { client_id: client, event: { ...event, provider_secret: "unexpected" } },
    { client_id: client },
  ]) {
    raw = value;
    assert.equal(
      (
        await e.call(identity, "admin.get_event", {
          client_id: client,
          event_id: id,
        })
      ).error?.code,
      "malformed_response",
    );
  }
});
for (const patch of [
  { event_type: "external" },
  { attendees: [] },
  { title: "" },
  { starts_at: "2026-01-01T10:00:00" },
  { notes: 5 },
  { created_by_bot: "bot_production" },
])
  test(`registry rejects malformed ${Object.keys(patch)[0]}`, (t) => {
    assert.equal(
      registry
        .find((t) => t.name === "admin.create_event")!
        .input.safeParse({ ...input, ...patch }).success,
      false,
    );
  });
test("DB and dual Admin auth refresh each request and deny revoked token/grants", async () => {
  for (const mode of ["db", "dual"] as const) {
    let value: AaResolveResult = {
      found: true,
      status: "active",
      bot_id: "bot_admin",
      clients: [client],
      permissions: [...grants.bot_admin],
    };
    let calls = 0;
    const token = "admin-test-only-credential".repeat(2);
    const auth = new BotAuthenticator(
      mode,
      mode === "dual" ? [{ ...identity, token }] : [],
      async () => {
        calls++;
        return value;
      },
    );
    await auth.authenticate(`Bearer ${token}`);
    value = { ...value, clients: [] };
    if (mode === "dual")
      await assert.rejects(
        auth.authenticate(`Bearer ${token}`),
        /unauthorized/,
      );
    else
      assert.deepEqual(
        (await auth.authenticate(`Bearer ${token}`)).clients,
        [],
      );
    value = { ...value, status: "revoked" };
    await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
    assert.equal(calls, 3);
  }
});
test("dual Admin never uses environment fallback on resolver outage", async () => {
  const token = "admin-test-only-credential".repeat(2);
  const auth = new BotAuthenticator(
    "dual",
    [{ ...identity, token }],
    async () => {
      throw Error("offline");
    },
  );
  await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
});
test("MCP HTTP discovery is 15, bad/revoked credentials return 401 immediately", async (t) => {
  const e = engine(t);
  const token = "admin-test-only-credential".repeat(2);
  let active = true;
  // Resolver test stub validates the digest, so an arbitrary credential cannot authenticate.
  const { tokenHashHex } = await import("../src/auth/identity.js");
  const realAuth = new BotAuthenticator("db", [], async (hash) =>
    hash === tokenHashHex(token)
      ? {
          found: true,
          status: active ? "active" : "revoked",
          bot_id: "bot_admin",
          clients: [client],
          permissions: [...grants.bot_admin],
        }
      : { found: false },
  );
  const c = config({
    BOT_AUTH_MODE: "db",
    BOT_CREDENTIALS_JSON: "[]",
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "reviewer", token: "test-reviewer".repeat(4) },
    ]),
    AA_INTERNAL_API_URL: "http://localhost:3000",
    AA_MCP_SERVICE_SECRET: "test-service".repeat(4),
  });
  const server = createServer(c, e, realAuth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  c.PUBLIC_ORIGIN = origin;
  const mcp = new Client({ name: "admin-test", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assertAdminDiscovery((await mcp.listTools()).tools.map((t) => t.name));
  for (const credential of ["invalid-test-only", token]) {
    active = false;
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
});
test("Gate 12 smoke runner executes through local MCP and reconciles fixtures", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const events = new Map<string, any>(),
    tasks = new Map<string, any>(),
    receipts = new Map<string, any>();
  const e = engine(t, {
    execute: async (tool: any, args: any, ctx: any) => {
      if (receipts.has(ctx.execution_id))
        return structuredClone(receipts.get(ctx.execution_id));
      const ok = (data: any) => ({
        status: "completed",
        capability: tool.name,
        data,
      });
      let result: any;
      switch (tool.name) {
        case "delivery.list_clients":
          return ok({ clients: [{ id: client }], next_cursor: null });
        case "delivery.get_client":
          return ok({
            client_id: client,
            client: { id: client, name: "Harbour Dental" },
          });
        case "delivery.get_status":
          return ok({ client_id: client, plan: [] });
        case "workflow.list_tasks":
          return ok({
            client_id: client,
            tasks: [...tasks.values()],
            next_cursor: null,
          });
        case "workflow.create_task": {
          const task = { id: randomUUID(), title: args.title, status: "open" };
          tasks.set(task.id, task);
          result = ok({ client_id: client, task });
          break;
        }
        case "workflow.assign_task": {
          const task = tasks.get(args.task_id);
          task.assignee = args.assignee;
          result = ok({ client_id: client, task });
          break;
        }
        case "workflow.complete_task": {
          const task = tasks.get(args.task_id);
          task.status = "complete";
          result = ok({ client_id: client, task });
          break;
        }
        case "workflow.get_task":
          return ok({ client_id: client, task: tasks.get(args.task_id) });
        case "admin.list_events":
          return ok({
            client_id: client,
            events: [...events.values()],
            next_cursor: null,
          });
        case "admin.create_event": {
          const row = {
            ...event,
            ...args,
            id: randomUUID(),
            version: 1,
            status: "scheduled",
          };
          events.set(row.id, row);
          result = ok({ client_id: client, event: row });
          break;
        }
        case "admin.update_event":
        case "admin.get_event": {
          const row = events.get(args.event_id);
          if (!row)
            return {
              status: "failed",
              capability: tool.name,
              error: { code: "event_not_found" },
            };
          if (tool.name === "admin.update_event") {
            assert.equal(row.version, args.expected_version);
            Object.assign(row, {
              status: args.status,
              version: row.version + 1,
            });
          }
          result = ok({ client_id: client, event: row });
          break;
        }
        default:
          throw Error("Unexpected tool");
      }
      result = structuredClone(result);
      if (tool.action === "write") receipts.set(ctx.execution_id, result);
      return structuredClone(result);
    },
  });
  const token = "local-admin-test-only".repeat(3);
  const c = config({
    BOT_AUTH_MODE: "env",
    BOT_CREDENTIALS_JSON: JSON.stringify([{ ...identity, token }]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: "local-reviewer-test".repeat(3) },
    ]),
  });
  const server = createServer(c, e);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  c.PUBLIC_ORIGIN = origin;
  const mcp = new Client({ name: "gate12-local", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assertAdminDiscovery((await mcp.listTools()).tools.map((t) => t.name));
  await runAdminGate(
    async (name, args) =>
      (await mcp.callTool({ name, arguments: args })).structuredContent,
    {
      approved_safe_fixtures: true,
      client_id: client,
      allowed_client_name: "Harbour Dental",
      denied_client_id: other,
      denied_client_name: "Attract Acquisition",
      denied_event_id: other,
      assignee: "bot_admin",
    },
  );
  assert.equal(events.size, 1);
  assert.ok([...events.values()].every((e) => e.status === "cancelled"));
  assert.ok([...tasks.values()].every((t) => t.status === "complete"));
});

test("dual mode rejects an env/DB identity mismatch involving Admin", async () => {
  const token = "admin-test-mismatch-only".repeat(2);
  const auth = new BotAuthenticator(
    "dual",
    [{ bot: "bot_marketing", clients: [client], token }],
    async () => ({
      found: true,
      status: "active",
      bot_id: "bot_admin",
      clients: [client],
      permissions: [...grants.bot_admin],
    }),
  );
  await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
});
test("Admin approval requests remain informational and cannot record decisions", async (t) => {
  let calls = 0;
  const e = engine(t, {
    execute: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  const result = await e.call(identity, "workflow.create_approval", {
    client_id: client,
    summary: "Local informational fixture",
    idempotency_key: "approval-test-12",
  });
  assert.equal(result.status, "approval_required");
  assert.equal(calls, 0);
  assert.equal(
    (
      await e.call(identity, "workflow.record_decision", {
        client_id: client,
        approval_id: result.approval_id,
        decision: "approved",
        idempotency_key: "denied-decision-key",
      })
    ).status,
    "rejected",
  );
});

test("hosted env Admin denies without disabling existing bot credentials", async () => {
  const adminToken = "synthetic-admin-env".repeat(3),
    otherToken = "synthetic-marketing-env".repeat(3);
  const auth = BotAuthenticator.fromConfig({
    BOT_AUTH_MODE: "env",
    PUBLIC_ORIGIN: "https://gateway.example.test",
    bots: [
      { ...identity, token: adminToken },
      { bot: "bot_marketing", clients: [client], token: otherToken },
    ],
  });
  await assert.rejects(
    auth.authenticate(`Bearer ${adminToken}`),
    /unauthorized/,
  );
  assert.equal(
    (await auth.authenticate(`Bearer ${otherToken}`)).bot,
    "bot_marketing",
  );
});
