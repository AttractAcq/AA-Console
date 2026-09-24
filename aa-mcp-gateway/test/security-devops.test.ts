import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as mockServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { securityDevops } from "../src/onboarding/security-devops.js";
import { allowed, grants } from "../src/policy/permissions.js";
import { bots } from "../src/shared/types.js";
import {
  BotAuthenticator,
  type AaResolveResult,
} from "../src/auth/identity.js";
import {
  assertSecurityDiscovery,
  runSecurityGate,
} from "../scripts/security-gate.js";
import { createServer } from "../src/server/http.js";
import { config } from "../src/server/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  id = "33333333-3333-4333-8333-333333333333";
const identity = { bot: "bot_security_devops" as const, clients: [client] };
const input = {
  client_id: client,
  title: "Fixture",
  notes: null,
  severity: "medium",
  kind: "finding",
  idempotency_key: "security-fixture-key",
};
const finding = {
  id,
  client_id: client,
  title: "Fixture",
  notes: null,
  kind: "finding",
  severity: "medium",
  status: "open",
  version: 1,
  created_by_bot: "bot_security_devops",
  updated_by_bot: "bot_security_devops",
  created_at: "2026-09-15T10:00:00.000Z",
  updated_at: "2026-09-15T10:00:00.000Z",
};
const page = {
  id,
  client_id: client,
  page_type: "landing",
  title: "Harbour Home",
  status: "approved",
  published_url: "https://example.test/harbour",
  created_at: finding.created_at,
  updated_at: finding.updated_at,
};
const job = {
  id,
  client_id: client,
  agent_key: "landing_page",
  status: "completed",
  attempts: 1,
  created_at: finding.created_at,
  started_at: finding.created_at,
  completed_at: finding.updated_at,
};
const systemStatus = {
  client_id: client,
  projection: "security_system_status_v1",
  jobs_by_status: { completed: 1 },
  pages_by_status: { approved: 1 },
  open_findings: 1,
  open_incidents: 0,
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
test("Security exact discovery equality is 14 and related stubs stay stub", (t) => {
  const e = engine(t);
  assertSecurityDiscovery(e.discover(identity).map((x) => x.name));
  assert.equal(registry.length, 104); // 103 + content.create_upload_url
  for (const name of securityDevops.grants)
    assert.equal(registry.find((x) => x.name === name)?.implementation, "real");
  for (const name of ["sales_agents.deploy", "pipeline.record_sale"])
    assert.equal(registry.find((x) => x.name === name)?.implementation, "stub");
  assert.equal(grants.bot_security_devops.includes("security.*"), false);
  assert.deepEqual(
    [...grants.bot_security_devops].sort(),
    [...securityDevops.grants].sort(),
  );
});
test("Security ceiling rejects broad grants; security tools deny every other bot", (t) => {
  const e = engine(t);
  const broad = {
    ...identity,
    permissions: registry.map((x) => `${x.domain}.*`),
  };
  assertSecurityDiscovery(e.discover(broad).map((x) => x.name));
  for (const bot of bots.filter((b) => b !== "bot_security_devops")) {
    for (const name of securityDevops.grants.filter((n) => n.startsWith("security."))) {
      const tool = registry.find((x) => x.name === name)!;
      assert.equal(
        allowed({ bot, clients: [client], permissions: ["security.*"] }, tool),
        false,
      );
    }
  }
  const engineering = {
    bot: "bot_engineering" as const,
    clients: [client],
  };
  assert.equal(
    allowed(engineering, registry.find((x) => x.name === "engineering.get_release_status")!),
    true,
  );
  assert.equal(
    allowed(engineering, registry.find((x) => x.name === "security.create_finding")!),
    false,
  );
  assert.equal(
    allowed(identity, registry.find((x) => x.name === "engineering.create_issue")!),
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
    (x) => !securityDevops.grants.some((n) => n === x.name),
  ))
    assert.equal(
      (
        await e.call(
          { ...identity, permissions: registry.map((x) => `${x.domain}.*`) },
          tool.name,
          {},
        )
      ).status,
      "rejected",
    );
  for (const name of [
    "security.get_system_status",
    "security.get_open_findings",
    "security.get_incident_status",
    "security.create_finding",
  ]) {
    const args =
      name === "security.create_finding"
        ? { ...input, client_id: other }
        : name === "security.get_open_findings"
          ? { client_id: other, finding_id: id }
          : { client_id: other };
    assert.equal((await e.call(identity, name, args)).message, "Client scope denied.");
  }
  assert.equal(calls, 0);
});
test("Security adapter routes domain tools with exact fields and correlation", async (t) => {
  const { adapter, seen } = await mockAa(t, (_body, path) => ({
    body: path.endsWith("create-finding")
      ? { client_id: client, finding }
      : path.endsWith("get-open-findings")
        ? { client_id: client, findings: [finding], next_cursor: null }
        : path.endsWith("get-incident-status")
          ? { client_id: client, incidents: [], next_cursor: null }
          : path.endsWith("get-system-status")
            ? systemStatus
            : path.endsWith("get-release-status")
              ? {
                  client_id: client,
                  projection: "client_pages_v1",
                  pages: [page],
                  next_cursor: null,
                }
              : {
                  client_id: client,
                  projection: "agent_jobs_v1",
                  jobs: [job],
                  next_cursor: null,
                },
  }));
  const e = engine(t, adapter);
  const cases = [
    ["security.get_system_status", { client_id: client }],
    ["security.get_open_findings", { client_id: client }],
    ["security.get_incident_status", { client_id: client }],
    ["engineering.get_release_status", { client_id: client }],
    ["engineering.get_deployment_status", { client_id: client }],
    ["security.create_finding", input],
  ] as const;
  for (const [name, args] of cases)
    assert.equal((await e.call(identity, name, args)).status, "completed");
  assert.deepEqual(
    seen.map((x) => x.path),
    [
      "/internal/mcp/security/get-system-status",
      "/internal/mcp/security/get-open-findings",
      "/internal/mcp/security/get-incident-status",
      "/internal/mcp/engineering/get-release-status",
      "/internal/mcp/engineering/get-deployment-status",
      "/internal/mcp/security/create-finding",
    ],
  );
  for (const x of seen) {
    assert.equal(x.headers["x-aa-bot-id"], "bot_security_devops");
    assert.ok(x.headers["x-request-id"]);
    assert.ok(x.headers["idempotency-key"]);
    assert.equal(x.body.idempotency_key, undefined);
    assert.equal(x.body.railway_token, undefined);
    assert.equal(x.body.env, undefined);
  }
});
test("Security replay reauthorizes in backend; same execution key, no cached success", async (t) => {
  let permitted = true;
  const { adapter, seen } = await mockAa(t, () =>
    permitted
      ? { body: { client_id: client, finding, replayed: false } }
      : { status: 403, body: { error: { code: "client_forbidden" } } },
  );
  const e = engine(t, adapter);
  assert.equal(
    (await e.call(identity, "security.create_finding", input)).status,
    "completed",
  );
  permitted = false;
  const replay = await e.call(identity, "security.create_finding", input);
  assert.equal(replay.error?.code, "client_forbidden");
  assert.equal(seen.length, 2);
  assert.equal(
    seen[0].headers["idempotency-key"],
    seen[1].headers["idempotency-key"],
  );
  assert.equal(
    (
      await e.call(identity, "security.create_finding", {
        ...input,
        title: "Changed",
      })
    ).status,
    "rejected",
  );
  assert.equal(seen.length, 2);
  const audit = e.store.activity(client, "bot_security_devops", 10);
  assert.ok(
    audit.some((a) => a.execution_id === seen[0].headers["idempotency-key"]),
  );
});
test("adapter rejects nested cross-client or extra secret fields", async (t) => {
  let raw: any = {
    client_id: client,
    findings: [{ ...finding, client_id: other }],
    next_cursor: null,
  };
  const { adapter } = await mockAa(t, () => ({ body: raw }));
  const e = engine(t, adapter);
  for (const value of [
    raw,
    {
      client_id: client,
      findings: [{ ...finding, id: other }],
      next_cursor: null,
    },
    {
      client_id: client,
      findings: [{ ...finding, token: "unexpected" }],
      next_cursor: null,
    },
    {
      client_id: client,
      findings: [{ ...finding, env: { SECRET: "x" } }],
      next_cursor: null,
    },
    { client_id: client },
  ]) {
    raw = value;
    assert.equal(
      (
        await e.call(identity, "security.get_open_findings", {
          client_id: client,
          finding_id: id,
        })
      ).error?.code,
      "malformed_response",
    );
  }
  raw = {
    client_id: client,
    projection: "security_system_status_v1",
    jobs_by_status: { completed: 1 },
    pages_by_status: { approved: 1 },
    open_findings: 0,
    open_incidents: 0,
    params: { secret: true },
  };
  assert.equal(
    (
      await e.call(identity, "security.get_system_status", {
        client_id: client,
      })
    ).error?.code,
    "malformed_response",
  );
});
for (const patch of [
  { title: "" },
  { notes: 5 },
  { severity: "secret" },
  { kind: "global" },
  { created_by_bot: "bot_engineering" },
  { railway_service: "web" },
  { env: { TOKEN: "x" } },
])
  test(`registry rejects malformed ${Object.keys(patch)[0]}`, () => {
    assert.equal(
      registry
        .find((x) => x.name === "security.create_finding")!
        .input.safeParse({ ...input, ...patch }).success,
      false,
    );
  });
test("DB and dual Security auth refresh each request and deny revoked token/grants", async () => {
  for (const mode of ["db", "dual"] as const) {
    let value: AaResolveResult = {
      found: true,
      status: "active",
      bot_id: "bot_security_devops",
      clients: [client],
      permissions: [...grants.bot_security_devops],
    };
    let calls = 0;
    const token = "security-test-only-credential".repeat(2);
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
      await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
    else
      assert.deepEqual((await auth.authenticate(`Bearer ${token}`)).clients, []);
    value = { ...value, status: "revoked" };
    await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
    assert.equal(calls, 3);
  }
});
test("hosted Security env credentials are refused except loopback HTTP", async () => {
  const token = "security-test-only-credential".repeat(2);
  const bots = [{ ...identity, token }];
  for (const origin of [
    "https://gateway.example.test",
    "http://localhost.evil.test",
    "https://localhost",
    "http://127.0.0.2",
  ]) {
    const auth = BotAuthenticator.fromConfig({
      BOT_AUTH_MODE: "env",
      PUBLIC_ORIGIN: origin,
      bots,
    });
    await assert.rejects(auth.authenticate(`Bearer ${token}`), /unauthorized/);
  }
  for (const origin of ["http://localhost", "http://127.0.0.1"]) {
    const auth = BotAuthenticator.fromConfig({
      BOT_AUTH_MODE: "env",
      PUBLIC_ORIGIN: origin,
      bots,
    });
    assert.equal(
      (await auth.authenticate(`Bearer ${token}`)).bot,
      "bot_security_devops",
    );
  }
});
test("dual Security never uses environment fallback on miss or resolver outage", async () => {
  const token = "security-test-only-credential".repeat(2);
  const envCreds = [{ ...identity, token }];
  await assert.rejects(
    new BotAuthenticator("dual", envCreds, async () => ({ found: false })).authenticate(
      `Bearer ${token}`,
    ),
    /unauthorized/,
  );
  await assert.rejects(
    new BotAuthenticator("dual", envCreds, async () => {
      throw Error("offline");
    }).authenticate(`Bearer ${token}`),
    /unauthorized/,
  );
});
test("MCP HTTP discovery is 14, bad/revoked credentials return 401 immediately", async (t) => {
  const e = engine(t);
  const token = "security-test-only-credential".repeat(2);
  let active = true;
  const { tokenHashHex } = await import("../src/auth/identity.js");
  const realAuth = new BotAuthenticator("db", [], async (hash) =>
    hash === tokenHashHex(token)
      ? {
          found: true,
          status: active ? "active" : "revoked",
          bot_id: "bot_security_devops",
          clients: [client],
          permissions: [...grants.bot_security_devops],
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
  const mcp = new Client({ name: "security-test", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assertSecurityDiscovery((await mcp.listTools()).tools.map((x) => x.name));
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
test("Gate 15 smoke runner executes through local MCP and reconciles fixtures", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const findings = new Map<string, any>(),
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
        case "security.get_system_status":
          return ok({
            client_id: client,
            projection: "security_system_status_v1",
            jobs_by_status: {},
            pages_by_status: {},
            open_findings: findings.size,
            open_incidents: 0,
          });
        case "security.get_open_findings":
          return ok({
            client_id: client,
            findings: args.finding_id
              ? [findings.get(args.finding_id)]
              : [...findings.values()],
            next_cursor: null,
          });
        case "security.get_incident_status":
          return ok({ client_id: client, incidents: [], next_cursor: null });
        case "engineering.get_release_status":
          return ok({
            client_id: client,
            projection: "client_pages_v1",
            pages: [],
            next_cursor: null,
          });
        case "engineering.get_deployment_status":
          return ok({
            client_id: client,
            projection: "agent_jobs_v1",
            jobs: [],
            next_cursor: null,
          });
        case "security.create_finding": {
          const row = {
            ...finding,
            ...args,
            id: randomUUID(),
            status: "open",
            version: 1,
            kind: args.kind ?? "finding",
          };
          findings.set(row.id, row);
          result = ok({ client_id: client, finding: row });
          break;
        }
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
        default:
          throw Error("Unexpected tool");
      }
      result = structuredClone(result);
      if (tool.action === "write") receipts.set(ctx.execution_id, result);
      return structuredClone(result);
    },
  });
  const token = "local-security-test-only".repeat(3);
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
  const mcp = new Client({ name: "gate15-local", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assertSecurityDiscovery((await mcp.listTools()).tools.map((x) => x.name));
  await runSecurityGate(
    async (name, args) =>
      (await mcp.callTool({ name, arguments: args })).structuredContent,
    {
      approved_safe_fixtures: true,
      client_id: client,
      denied_client_id: other,
      denied_client_name: "Attract Acquisition",
      assignee: "bot_security_devops",
    },
  );
  assert.equal(findings.size, 1);
  assert.ok([...tasks.values()].every((x) => x.status === "complete"));
});
test("Security approval requests remain informational and cannot record decisions", async (t) => {
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
    idempotency_key: "approval-test-15",
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
