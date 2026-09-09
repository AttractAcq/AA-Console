import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as mockServer } from "node:http";
import { once } from "node:events";
import { Store } from "../src/audit/store.js";
import { ActionEngine } from "../src/policy/engine.js";
import { registry } from "../src/registry/tools.js";
import {
  BotAuthenticator,
  authenticate,
  tokenHashHex,
  type AaResolveResult,
} from "../src/auth/identity.js";
import { grants, permissionMatches } from "../src/policy/permissions.js";
import { config } from "../src/server/config.js";
import { createServer } from "../src/server/http.js";
import type { Identity } from "../src/shared/types.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const identity: Identity = { bot: "bot_production", clients: [client] };
const token = "a".repeat(40);
const credentials = [{ ...identity, token }];
const reviewers = JSON.stringify([{ id: "human", token: "b".repeat(40) }]);
const env = {
  BOT_CREDENTIALS_JSON: JSON.stringify(credentials),
  REVIEWER_CREDENTIALS_JSON: reviewers,
};

function activeResolve(overrides: Partial<AaResolveResult> = {}): AaResolveResult {
  return {
    found: true,
    status: "active",
    bot_id: "bot_production",
    token_id: "33333333-3333-4333-8333-333333333333",
    clients: [client],
    permissions: [...grants.bot_production],
    ...overrides,
  };
}

test("BOT_AUTH_MODE defaults to dual and db refuses nonempty env credentials", () => {
  assert.equal(config(env).BOT_AUTH_MODE, "dual");
  assert.equal(config({ ...env, BOT_AUTH_MODE: "env" }).BOT_AUTH_MODE, "env");
  assert.throws(() =>
    config({
      ...env,
      BOT_AUTH_MODE: "db",
      AA_INTERNAL_API_URL: "https://aa.example.com",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }),
  );
  assert.equal(
    config({
      BOT_AUTH_MODE: "db",
      BOT_CREDENTIALS_JSON: "[]",
      REVIEWER_CREDENTIALS_JSON: reviewers,
      AA_INTERNAL_API_URL: "https://aa.example.com",
      AA_MCP_SERVICE_SECRET: "c".repeat(40),
    }).bots.length,
    0,
  );
});

test("permission matcher is exact or single-segment domain wildcard only", () => {
  assert.equal(permissionMatches("content.generate_brief", "content.generate_brief"), true);
  assert.equal(permissionMatches("content.*", "content.generate_brief"), true);
  assert.equal(permissionMatches("content.*", "content.foo.bar"), false);
  assert.equal(permissionMatches("content.*", "content."), false);
  assert.equal(permissionMatches("content.*", "contentX.generate_brief"), false);
  assert.equal(permissionMatches("content.*", "content"), false);
  assert.equal(permissionMatches("content.generate", "content.generate_brief"), false);
  assert.equal(permissionMatches("workflow.*", "workflow.record_decision"), true);
  assert.equal(
    grants.bot_production.some((g) =>
      permissionMatches(g, "workflow.record_decision"),
    ),
    false,
  );
  assert.equal(
    grants.bot_chief_of_staff.some((g) =>
      permissionMatches(g, "workflow.record_decision"),
    ),
    true,
  );
});

test("CoS domain prohibitions stay in the code matrix", () => {
  assert.equal(grants.bot_production.some((g) => permissionMatches(g, "economics.get_costs")), false);
  assert.equal(grants.bot_production.some((g) => permissionMatches(g, "security.get_system_status")), false);
  assert.equal(grants.bot_production.some((g) => permissionMatches(g, "sales_agents.deploy")), false);
  assert.equal(grants.bot_finance.some((g) => permissionMatches(g, "content.generate_brief")), false);
  assert.equal(grants.bot_finance.some((g) => permissionMatches(g, "content.submit_asset")), false);
  assert.equal(
    grants.bot_security_devops.some((g) => permissionMatches(g, "economics.get_revenue")),
    false,
  );
  assert.equal(
    grants.bot_security_devops.some((g) =>
      permissionMatches(g, "attribution.get_revenue_attribution"),
    ),
    false,
  );
  assert.equal(
    grants.bot_security_devops.some((g) => g.includes("finance_periods")),
    false,
  );
});

test("workflow.record_decision stays hard-denied in code even with workflow.*", async () => {
  const store = new Store(":memory:");
  const engine = new ActionEngine(store, registry, {
    async execute() {
      return { status: "completed", capability: "workflow.record_decision" };
    },
  }, true);
  const r = await engine.call(identity, "workflow.record_decision", {
    client_id: client,
    approval_id: client,
    decision: "approved",
    idempotency_key: "decision-key",
  });
  assert.equal(r.status, "rejected");
  store.close();
});

test("dual-read match authenticates; mismatch denies with a secret-free alert", async () => {
  const alerts: Record<string, unknown>[] = [];
  const auth = new BotAuthenticator(
    "dual",
    credentials,
    async () => activeResolve(),
    (event) => alerts.push(event),
  );
  assert.deepEqual(await auth.authenticate(`Bearer ${token}`), identity);
  const mismatch = new BotAuthenticator(
    "dual",
    credentials,
    async () => activeResolve({ bot_id: "bot_finance", clients: [other] }),
    (event) => alerts.push(event),
  );
  await assert.rejects(() => mismatch.authenticate(`Bearer ${token}`), /unauthorized/);
  assert.equal(alerts[0]?.event, "bot_auth_mismatch");
  assert.equal(alerts[0]?.bot_aa, "bot_finance");
  assert.equal(alerts[0]?.bot_env, "bot_production");
  assert.ok(!JSON.stringify(alerts).includes(token));
  assert.ok(!JSON.stringify(alerts).includes(tokenHashHex(token)));
});

test("dual-read permission-set mismatch denies", async () => {
  const auth = new BotAuthenticator(
    "dual",
    credentials,
    async () => activeResolve({ permissions: ["content.generate_brief"] }),
  );
  await assert.rejects(() => auth.authenticate(`Bearer ${token}`), /unauthorized/);
});

test("revoked or suspended AA hit is denied and does not fall back to env", async () => {
  for (const status of ["suspended", "revoked", "revoked_token", "expired"]) {
    const auth = new BotAuthenticator("dual", credentials, async () => ({
      found: true,
      status,
      bot_id: "bot_production",
      token_id: "33333333-3333-4333-8333-333333333333",
    }));
    await assert.rejects(() => auth.authenticate(`Bearer ${token}`), /unauthorized/);
  }
});

test("dual-read falls back to env on AA miss and db mode requires AA", async () => {
  const dual = new BotAuthenticator("dual", credentials, async () => ({ found: false }));
  assert.deepEqual(await dual.authenticate(`Bearer ${token}`), identity);
  const db = new BotAuthenticator("db", [], async () => ({ found: false }));
  await assert.rejects(() => db.authenticate(`Bearer ${token}`), /unauthorized/);
  const dbOk = new BotAuthenticator("db", [], async () => activeResolve());
  assert.deepEqual(await dbOk.authenticate(`Bearer ${token}`), {
    ...identity,
    permissions: [...grants.bot_production],
  });
});

test("db mode allows a tool present only in AA permissions", async () => {
  const auth = new BotAuthenticator("db", [], async () =>
    activeResolve({ permissions: ["economics.get_costs"] }),
  );
  const id = await auth.authenticate(`Bearer ${token}`);
  assert.deepEqual(id.permissions, ["economics.get_costs"]);
  assert.equal(
    grants.bot_production.some((g) => permissionMatches(g, "economics.get_costs")),
    false,
  );
  const store = new Store(":memory:");
  const engine = new ActionEngine(
    store,
    registry,
    {
      async execute() {
        return { status: "completed", capability: "economics.get_costs" };
      },
    },
    true,
  );
  assert.ok(engine.discover(id).some((t) => t.name === "economics.get_costs"));
  const r = await engine.call(id, "economics.get_costs", { client_id: client });
  assert.equal(r.status, "completed");
  store.close();
});

test("db mode denies a tool in the code matrix but absent from AA permissions", async () => {
  const auth = new BotAuthenticator("db", [], async () =>
    activeResolve({ permissions: ["workflow.get_activity"] }),
  );
  const id = await auth.authenticate(`Bearer ${token}`);
  const store = new Store(":memory:");
  const engine = new ActionEngine(store, registry, {
    async execute() {
      return { status: "completed", capability: "content.generate_brief" };
    },
  });
  assert.ok(grants.bot_production.some((g) => permissionMatches(g, "content.generate_brief")));
  assert.ok(!engine.discover(id).some((t) => t.name === "content.generate_brief"));
  const r = await engine.call(id, "content.generate_brief", {
    client_id: client,
    idea_id: "22222222-2222-4222-8222-222222222222",
    idempotency_key: "db-deny-brief",
  });
  assert.equal(r.status, "rejected");
  store.close();
});

test("workflow.record_decision stays hard-denied in db mode even if AA lists it", async () => {
  const auth = new BotAuthenticator("db", [], async () =>
    activeResolve({
      permissions: ["workflow.*", "workflow.record_decision", "content.*"],
    }),
  );
  const id = await auth.authenticate(`Bearer ${token}`);
  const store = new Store(":memory:");
  const engine = new ActionEngine(
    store,
    registry,
    {
      async execute() {
        return { status: "completed", capability: "workflow.record_decision" };
      },
    },
    true,
  );
  assert.ok(!engine.discover(id).some((t) => t.name === "workflow.record_decision"));
  const r = await engine.call(id, "workflow.record_decision", {
    client_id: client,
    approval_id: client,
    decision: "approved",
    idempotency_key: "db-decision-key",
  });
  assert.equal(r.status, "rejected");
  store.close();
});

test("HTTP dual-read match, mismatch 401, and reviewer path stay on REVIEWER_CREDENTIALS_JSON", async () => {
  const hash = tokenHashHex(token);
  let resolveBody: unknown;
  const upstream = mockServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/internal/mcp/auth/resolve") {
      resolveBody = JSON.parse(raw);
      const wanted = JSON.parse(raw).token_hash === hash;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(wanted ? activeResolve() : { found: false }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address() as { port: number };
  const store = new Store(":memory:");
  const engine = new ActionEngine(store, registry, { async execute() {
    return { status: "not_implemented", capability: "x" };
  } });
  const c = config({
    ...env,
    BOT_AUTH_MODE: "dual",
    AA_INTERNAL_API_URL: `http://127.0.0.1:${address.port}`,
    AA_MCP_SERVICE_SECRET: "c".repeat(40),
  });
  const server = createServer(c, engine);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  c.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
  try {
    const ok = await fetch(c.PUBLIC_ORIGIN + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(ok.status, 200);
    const list: { result: { tools: { name: string }[] } } = await ok.json();
    const allowed = new Set([
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
    assert.ok(list.result.tools.some((t) => t.name === "content.generate_brief"));
    assert.ok(list.result.tools.every((t) => allowed.has(t.name)));
    assert.deepEqual(resolveBody, { token_hash: hash });
    const otherToken = "d".repeat(40);
    const denied = await fetch(c.PUBLIC_ORIGIN + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${otherToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, "unauthorized");
    assert.equal(
      (await fetch(c.PUBLIC_ORIGIN + "/admin/approvals", {
        headers: { authorization: `Bearer ${token}` },
      })).status,
      401,
    );
    assert.equal(
      (await fetch(c.PUBLIC_ORIGIN + "/admin/approvals", {
        headers: { authorization: `Bearer ${"b".repeat(40)}` },
      })).status,
      200,
    );
    const dumped = JSON.stringify(store.activity(client, identity.bot, 100));
    const auditAll = store.db.prepare("SELECT body FROM audit").all();
    const blob = JSON.stringify(auditAll);
    assert.ok(!blob.includes(token));
    assert.ok(!blob.includes(hash));
    assert.ok(!blob.includes("Bearer"));
    assert.ok(!dumped.includes(hash));
  } finally {
    server.close();
    await once(server, "close");
    upstream.close();
    await once(upstream, "close");
    store.close();
  }
});

test("env authenticate helper remains uniform 401 and never returns secrets", () => {
  assert.throws(() => authenticate("Bearer " + "z".repeat(40), credentials), /unauthorized/);
  assert.deepEqual(authenticate(`Bearer ${token}`, credentials), identity);
  assert.equal(createHash("sha256").update(token).digest("hex"), tokenHashHex(token));
});
