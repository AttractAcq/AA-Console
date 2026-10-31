import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Store } from "../src/audit/store.js";
import {
  BotAuthenticator,
  tokenHashHex,
  type AaResolveResult,
} from "../src/auth/identity.js";
import { ActionEngine } from "../src/policy/engine.js";
import { grants } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";
import { config } from "../src/server/config.js";
import { createServer } from "../src/server/http.js";
import type { Bot } from "../src/shared/types.js";

const client = "11111111-1111-4111-8111-111111111111";
const botToken = "a".repeat(40);
const reviewerToken = "b".repeat(40);
const localTools = [
  "workflow.get_activity",
  "workflow.get_pending_approvals",
  "workflow.create_approval",
];

function active(
  bot: Bot,
  overrides: Partial<AaResolveResult> = {},
): AaResolveResult {
  return {
    found: true,
    status: "active",
    bot_id: bot,
    token_id: "33333333-3333-4333-8333-333333333333",
    clients: [client],
    permissions: [...grants[bot]],
    ...overrides,
  };
}

function fixture(mode: "dual" | "db", bot: Bot) {
  const credentials = [{ bot, clients: [client], token: botToken }];
  const c = config({
    BOT_AUTH_MODE: mode,
    BOT_CREDENTIALS_JSON: mode === "db" ? "[]" : JSON.stringify(credentials),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: reviewerToken },
    ]),
    AA_INTERNAL_API_URL: "https://aa.example.test",
    AA_MCP_SERVICE_SECRET: "c".repeat(40),
  });
  let response: AaResolveResult | "outage" = active(bot);
  let resolves = 0;
  const auth = BotAuthenticator.fromConfig(
    c,
    () => {},
    async (hash) => {
      resolves++;
      assert.equal(hash, tokenHashHex(botToken));
      if (response === "outage") throw new Error("upstream down");
      return response;
    },
  );
  return {
    c,
    auth,
    setResponse(next: AaResolveResult | "outage") {
      response = next;
    },
    resolves: () => resolves,
  };
}

async function start(
  c: ReturnType<typeof config>,
  engine: ActionEngine,
  auth: BotAuthenticator,
) {
  const server = createServer(c, engine, auth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  c.PUBLIC_ORIGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    async mcp(
      method: string,
      params: Record<string, unknown> = {},
      token = botToken,
    ) {
      const response = await fetch(c.PUBLIC_ORIGIN + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return { status: response.status, body: (await response.json()) as any };
    },
    async execute(id: string) {
      const response = await fetch(
        c.PUBLIC_ORIGIN + `/admin/approvals/${id}/execute`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${reviewerToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

for (const mode of ["dual", "db"] as const) {
  test(`${mode} gateway-local activity is hidden and denied on a fresh grant loss, token miss, outage, or suspension`, async (t) => {
    const f = fixture(mode, "bot_production");
    const store = new Store(":memory:");
    t.after(() => store.close());
    store.audit({
      bot: "bot_production",
      client_id: client,
      tool: "content.generate_brief",
      execution_result: "accepted",
    });
    const engine = new ActionEngine(store, registry, {
      async execute() {
        return { status: "not_implemented", capability: "x" };
      },
    });
    const app = await start(f.c, engine, f.auth);
    t.after(app.close);

    const listed = await app.mcp("tools/list");
    assert.equal(listed.status, 200);
    for (const name of localTools)
      assert.ok(
        listed.body.result.tools.some(
          (tool: { name: string }) => tool.name === name,
        ),
      );
    const healthy = await app.mcp("tools/call", {
      name: "workflow.get_activity",
      arguments: { client_id: client, limit: 10 },
    });
    assert.equal(healthy.body.result.structuredContent.status, "completed");
    assert.equal(healthy.body.result.structuredContent.data.activity.length, 1);

    for (const lost of [
      active("bot_production", { clients: [] }),
      { found: false },
      "outage",
      active("bot_production", { status: "suspended" }),
    ] as const) {
      f.setResponse(lost);
      const before = f.resolves();
      const denied = await app.mcp("tools/call", {
        name: "workflow.get_activity",
        arguments: { client_id: client, limit: 10 },
      });
      assert.equal(denied.body.result.structuredContent.status, "rejected");
      assert.equal(denied.body.result.structuredContent.data, undefined);
      assert.ok(
        f.resolves() > before,
        "sensitive call must bypass the positive cache",
      );
      for (const name of localTools.slice(1)) {
        const other = await app.mcp("tools/call", {
          name,
          arguments: { client_id: client, limit: 10 },
        });
        assert.ok(
          other.status === 401 ||
            other.body.result?.structuredContent?.status === "rejected",
        );
      }
      const hidden = await app.mcp("tools/list");
      if (hidden.status === 200)
        for (const name of localTools)
          assert.ok(
            !hidden.body.result.tools.some(
              (tool: { name: string }) => tool.name === name,
            ),
          );
      else
        assert.equal(
          hidden.status,
          401,
          "a cached denial may reject the whole list",
        );
      f.setResponse(active("bot_production"));
      await f.auth.authenticateFresh(`Bearer ${botToken}`);
    }
    const audit = JSON.stringify(
      store.db.prepare("SELECT body FROM audit").all(),
    );
    assert.ok(!audit.includes(botToken));
    assert.ok(!audit.includes(tokenHashHex(botToken)));
  });
}

for (const mode of ["dual", "db"] as const) {
  for (const [reason, lost] of [
    ["client grant removed", active("bot_production", { clients: [] })],
    ["token revoked", { found: false }],
    ["AA unavailable", "outage"],
    ["Bot suspended", active("bot_production", { status: "suspended" })],
    [
      "write permission removed",
      active("bot_production", {
        permissions: grants.bot_production.filter(
          (grant) => grant !== "content.*" && grant !== "workflow.create_approval",
        ),
      }),
    ],
  ] as const) {
    test(`${mode} ${reason} blocks all writes before a SQLite receipt or approval card`, async (t) => {
      const f = fixture(mode, "bot_production");
      const store = new Store(":memory:");
      t.after(() => store.close());
      let adapterCalls = 0;
      const engine = new ActionEngine(store, registry, {
        async execute(tool) {
          adapterCalls++;
          return { status: "accepted", capability: tool.name };
        },
      });
      const app = await start(f.c, engine, f.auth);
      t.after(app.close);
      const warm = await app.mcp("tools/list");
      assert.equal(warm.status, 200);
      assert.ok(
        warm.body.result.tools.some(
          (tool: { name: string }) => tool.name === "content.generate_brief",
        ),
      );

      f.setResponse(lost);
      const before = f.resolves();
      for (const [name, args] of [
        [
          "content.generate_brief",
          {
            client_id: client,
            idea_id: "22222222-2222-4222-8222-222222222222",
            idempotency_key: `blocked-brief-${mode}`,
          },
        ],
        [
          "workflow.create_approval",
          {
            client_id: client,
            summary: "Blocked action must not create a card",
            idempotency_key: `blocked-approval-${mode}`,
          },
        ],
      ] as const) {
        const denied = await app.mcp("tools/call", {
          name,
          arguments: args,
        });
        assert.ok(
          denied.status === 401 ||
            denied.body.result?.structuredContent?.status === "rejected",
        );
      }
      assert.ok(f.resolves() > before, "write gate must bypass auth cache");
      assert.equal(adapterCalls, 0);
      assert.equal(
        (store.db.prepare("SELECT count(*) AS count FROM receipts").get() as {
          count: number;
        }).count,
        0,
      );
      assert.equal(store.approvals().length, 0);

      const hidden = await app.mcp("tools/list");
      if (hidden.status === 200)
        for (const name of ["content.generate_brief", "workflow.create_approval"])
          assert.ok(
            !hidden.body.result.tools.some(
              (tool: { name: string }) => tool.name === name,
            ),
          );
      else assert.equal(hidden.status, 401);
    });
  }
}

test("healthy AA grant allows a write receipt and an approval card", async (t) => {
  const f = fixture("dual", "bot_production");
  const store = new Store(":memory:");
  t.after(() => store.close());
  let adapterCalls = 0;
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      adapterCalls++;
      return { status: "accepted", capability: tool.name };
    },
  });
  const app = await start(f.c, engine, f.auth);
  t.after(app.close);

  const write = await app.mcp("tools/call", {
    name: "content.generate_brief",
    arguments: {
      client_id: client,
      idea_id: "22222222-2222-4222-8222-222222222222",
      idempotency_key: "healthy-brief",
    },
  });
  assert.equal(write.body.result.structuredContent.status, "accepted");
  assert.equal(adapterCalls, 1);
  const approval = await app.mcp("tools/call", {
    name: "workflow.create_approval",
    arguments: {
      client_id: client,
      summary: "Review healthy plan",
      idempotency_key: "healthy-approval",
    },
  });
  assert.equal(approval.body.result.structuredContent.status, "approval_required");
  assert.equal(store.approvals().length, 1);
  assert.equal(
    (store.db.prepare("SELECT count(*) AS count FROM receipts").get() as {
      count: number;
    }).count,
    2,
  );
});

test("dual AA-only token needs the exact current AA permission for each local tool", async (t) => {
  const c = config({
    BOT_AUTH_MODE: "dual",
    BOT_CREDENTIALS_JSON: JSON.stringify([
      {
        bot: "bot_production",
        clients: [client],
        token: "z".repeat(40),
      },
    ]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: reviewerToken },
    ]),
    AA_INTERNAL_API_URL: "https://aa.example.test",
    AA_MCP_SERVICE_SECRET: "c".repeat(40),
  });
  let permissions = ["workflow.get_activity"];
  const auth = BotAuthenticator.fromConfig(
    c,
    () => {},
    async (hash) => {
      assert.equal(hash, tokenHashHex(botToken));
      return active("bot_production", { permissions });
    },
  );
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, {
    async execute() {
      return { status: "not_implemented", capability: "x" };
    },
  });
  const app = await start(c, engine, auth);
  t.after(app.close);
  const listed = await app.mcp("tools/list");
  const names = listed.body.result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  assert.ok(names.includes("workflow.get_activity"));
  assert.ok(!names.includes("workflow.get_pending_approvals"));
  assert.ok(!names.includes("workflow.create_approval"));
  const allowed = await app.mcp("tools/call", {
    name: "workflow.get_activity",
    arguments: { client_id: client, limit: 10 },
  });
  assert.equal(allowed.body.result.structuredContent.status, "completed");
  permissions = [];
  const denied = await app.mcp("tools/call", {
    name: "workflow.get_activity",
    arguments: { client_id: client, limit: 10 },
  });
  assert.equal(denied.body.result.structuredContent.status, "rejected");
});

test("dual AA-only reviewed action cannot execute after its AA permission is removed", async (t) => {
  const c = config({
    BOT_AUTH_MODE: "dual",
    BOT_CREDENTIALS_JSON: JSON.stringify([
      {
        bot: "bot_marketing",
        clients: [client],
        token: "z".repeat(40),
      },
    ]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: reviewerToken },
    ]),
    AA_INTERNAL_API_URL: "https://aa.example.test",
    AA_MCP_SERVICE_SECRET: "c".repeat(40),
  });
  let permissions = ["sites.provision"];
  const auth = BotAuthenticator.fromConfig(
    c,
    () => {},
    async () => active("bot_marketing", { permissions }),
  );
  const store = new Store(":memory:");
  t.after(() => store.close());
  let writes = 0;
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      writes++;
      return { status: "completed", capability: tool.name };
    },
  });
  const app = await start(c, engine, auth);
  t.after(app.close);
  const pendingResponse = await app.mcp("tools/call", {
    name: "sites.provision",
    arguments: {
      client_id: client,
      repo: "harbour",
      idempotency_key: "aa-only-provision-0001",
    },
  });
  const pending = pendingResponse.body.result.structuredContent;
  assert.equal(pending.status, "approval_required");
  assert.equal(
    store.getApproval(pending.approval_id!).request_token_id,
    "33333333-3333-4333-8333-333333333333",
  );
  engine.decide(pending.approval_id!, "human", "approved");
  permissions = [];
  const denied = await app.execute(pending.approval_id!);
  assert.equal(denied.status, 401);
  assert.equal(writes, 0);
  assert.equal(
    store.getApproval(pending.approval_id!).execution_status,
    "not_started",
  );
  permissions = ["sites.provision"];
  const allowed = await app.execute(pending.approval_id!);
  assert.equal(allowed.status, 200);
  assert.equal(writes, 1);
});

for (const mode of ["dual", "db"] as const) {
  test(`${mode} reviewer execution rechecks current Bot/client grants before consuming approval`, async (t) => {
    const f = fixture(mode, "bot_marketing");
    const store = new Store(":memory:");
    t.after(() => store.close());
    let externalWrites = 0;
    const engine = new ActionEngine(store, registry, {
      async execute(tool) {
        externalWrites++;
        return { status: "completed", capability: tool.name };
      },
    });
    const app = await start(f.c, engine, f.auth);
    t.after(app.close);
    const pendingResponse = await app.mcp("tools/call", {
      name: "sites.provision",
      arguments: {
        client_id: client,
        repo: "harbour",
        idempotency_key: `provision-${mode}-0001`,
      },
    });
    const pending = pendingResponse.body.result.structuredContent;
    assert.equal(pending.status, "approval_required");
    assert.equal(
      store.getApproval(pending.approval_id!).request_token_id,
      "33333333-3333-4333-8333-333333333333",
    );
    engine.decide(pending.approval_id!, "human", "approved");

    for (const lost of [
      active("bot_marketing", { clients: [] }),
      active("bot_marketing", { permissions: [] }),
      active("bot_marketing", { status: "suspended" }),
      { found: false },
      "outage",
    ] as const) {
      f.setResponse(lost);
      const denied = await app.execute(pending.approval_id!);
      assert.ok([401, 409].includes(denied.status));
      assert.equal(externalWrites, 0);
      assert.equal(
        store.getApproval(pending.approval_id!).execution_status,
        "not_started",
      );
    }

    f.setResponse(active("bot_marketing"));
    const allowed = await app.execute(pending.approval_id!);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, "completed");
    assert.equal(externalWrites, 1);
    assert.equal(store.getApproval(pending.approval_id!).status, "executed");
  });
}

test("revoking token A cannot execute its approved card through token B for the same Bot", async (t) => {
  const tokenB = "d".repeat(40);
  const tokenIdA = "33333333-3333-4333-8333-333333333333";
  const tokenIdB = "44444444-4444-4444-8444-444444444444";
  const c = config({
    BOT_AUTH_MODE: "db",
    BOT_CREDENTIALS_JSON: "[]",
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: reviewerToken },
    ]),
    AA_INTERNAL_API_URL: "https://aa.example.test",
    AA_MCP_SERVICE_SECRET: "c".repeat(40),
  });
  let revokedA = false;
  const auth = BotAuthenticator.fromConfig(c, () => {}, async (hash) => {
    if (hash === tokenHashHex(botToken))
      return active("bot_marketing", {
        token_id: tokenIdA,
        status: revokedA ? "revoked_token" : "active",
      });
    if (hash === tokenHashHex(tokenB))
      return active("bot_marketing", { token_id: tokenIdB });
    return { found: false };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  let externalWrites = 0;
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      externalWrites++;
      return { status: "completed", capability: tool.name };
    },
  });
  const app = await start(c, engine, auth);
  t.after(app.close);

  const cardAResponse = await app.mcp("tools/call", {
    name: "sites.provision",
    arguments: {
      client_id: client,
      repo: "harbour-a",
      idempotency_key: "token-a-provision",
    },
  });
  const cardA = cardAResponse.body.result.structuredContent;
  assert.equal(cardA.status, "approval_required");
  assert.equal(store.getApproval(cardA.approval_id).request_token_id, tokenIdA);
  engine.decide(cardA.approval_id, "human", "approved");

  const bListed = await app.mcp("tools/list", {}, tokenB);
  assert.equal(bListed.status, 200);
  assert.ok(
    bListed.body.result.tools.some(
      (tool: { name: string }) => tool.name === "sites.provision",
    ),
  );
  revokedA = true;
  const deniedA = await app.execute(cardA.approval_id);
  assert.equal(deniedA.status, 401);
  assert.equal(externalWrites, 0);
  assert.equal(
    store.getApproval(cardA.approval_id).execution_status,
    "not_started",
  );

  const cardBResponse = await app.mcp(
    "tools/call",
    {
      name: "sites.provision",
      arguments: {
        client_id: client,
        repo: "harbour-b",
        idempotency_key: "token-b-provision",
      },
    },
    tokenB,
  );
  const cardB = cardBResponse.body.result.structuredContent;
  assert.equal(cardB.status, "approval_required");
  assert.equal(store.getApproval(cardB.approval_id).request_token_id, tokenIdB);
  engine.decide(cardB.approval_id, "human", "approved");
  const executedB = await app.execute(cardB.approval_id);
  assert.equal(executedB.status, 200);
  assert.equal(externalWrites, 1);
  assert.equal(store.getApproval(cardA.approval_id).status, "approved");
  const persisted = JSON.stringify(store.approvals());
  assert.ok(!persisted.includes(botToken));
  assert.ok(!persisted.includes(tokenB));
  assert.ok(!persisted.includes(tokenHashHex(botToken)));
  assert.ok(!persisted.includes(tokenHashHex(tokenB)));
});

test("legacy approval without a requesting token ID remains unconsumed", async (t) => {
  const f = fixture("db", "bot_marketing");
  const store = new Store(":memory:");
  t.after(() => store.close());
  let externalWrites = 0;
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      externalWrites++;
      return { status: "completed", capability: tool.name };
    },
  });
  const app = await start(f.c, engine, f.auth);
  t.after(app.close);
  const identity = await f.auth.authenticate(`Bearer ${botToken}`);
  const card = await engine.call(identity, "sites.provision", {
    client_id: client,
    repo: "legacy",
    idempotency_key: "legacy-no-token-id",
  });
  assert.equal(card.status, "approval_required");
  assert.equal(store.getApproval(card.approval_id!).request_token_id, null);
  engine.decide(card.approval_id!, "human", "approved");
  const denied = await app.execute(card.approval_id!);
  assert.equal(denied.status, 401);
  assert.equal(externalWrites, 0);
  assert.equal(
    store.getApproval(card.approval_id!).execution_status,
    "not_started",
  );
});

test("after a gateway restart only the original token reauthentication unlocks its card", async (t) => {
  const f = fixture("db", "bot_marketing");
  const store = new Store(":memory:");
  t.after(() => store.close());
  let externalWrites = 0;
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      externalWrites++;
      return { status: "completed", capability: tool.name };
    },
  });
  const first = await start(f.c, engine, f.auth);
  const pendingResponse = await first.mcp("tools/call", {
    name: "sites.provision",
    arguments: {
      client_id: client,
      repo: "restart-card",
      idempotency_key: "restart-card-001",
    },
  });
  const card = pendingResponse.body.result.structuredContent;
  assert.equal(card.status, "approval_required");
  engine.decide(card.approval_id, "human", "approved");
  await first.close();

  const restartedAuth = BotAuthenticator.fromConfig(
    f.c,
    () => {},
    async (hash) => {
      assert.equal(hash, tokenHashHex(botToken));
      return active("bot_marketing");
    },
  );
  const restarted = await start(f.c, engine, restartedAuth);
  t.after(restarted.close);
  const beforeLogin = await restarted.execute(card.approval_id);
  assert.equal(beforeLogin.status, 401);
  assert.equal(externalWrites, 0);
  assert.equal(store.getApproval(card.approval_id).execution_status, "not_started");

  const login = await restarted.mcp("tools/list");
  assert.equal(login.status, 200);
  const afterLogin = await restarted.execute(card.approval_id);
  assert.equal(afterLogin.status, 200);
  assert.equal(externalWrites, 1);
});

test("hosted env mode fails closed for gateway-local sensitive access; loopback fixtures remain usable", async () => {
  const credentials = [
    { bot: "bot_production" as const, clients: [client], token: botToken },
  ];
  const hosted = BotAuthenticator.fromConfig({
    BOT_AUTH_MODE: "env",
    PUBLIC_ORIGIN: "https://gateway.example.test",
    bots: credentials,
  });
  assert.equal(
    (await hosted.authenticate(`Bearer ${botToken}`)).bot,
    "bot_production",
  );
  await assert.rejects(
    () => hosted.authenticateFresh(`Bearer ${botToken}`),
    /unauthorized/,
  );
  await assert.rejects(
    () => hosted.freshIdentityForApproval("bot_production", null),
    /unauthorized/,
  );
  const local = BotAuthenticator.fromConfig({
    BOT_AUTH_MODE: "env",
    PUBLIC_ORIGIN: "http://localhost:3100",
    bots: credentials,
  });
  assert.equal(
    (await local.authenticateFresh(`Bearer ${botToken}`)).identity.bot,
    "bot_production",
  );
});

test("hosted env MCP hides writes and cannot create local receipts or cards", async (t) => {
  const c = config({
    BOT_AUTH_MODE: "env",
    PUBLIC_ORIGIN: "https://gateway.example.test",
    BOT_CREDENTIALS_JSON: JSON.stringify([
      { bot: "bot_production", clients: [client], token: botToken },
    ]),
    REVIEWER_CREDENTIALS_JSON: JSON.stringify([
      { id: "human", token: reviewerToken },
    ]),
  });
  const auth = BotAuthenticator.fromConfig(c);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, {
    async execute(tool) {
      return { status: "accepted", capability: tool.name };
    },
  });
  const app = await start(c, engine, auth);
  t.after(app.close);

  const listed = await app.mcp("tools/list");
  assert.equal(listed.status, 200);
  assert.ok(
    listed.body.result.tools.some(
      (tool: { name: string }) => tool.name === "content.get_brief",
    ),
  );
  for (const name of ["content.generate_brief", "workflow.create_approval"])
    assert.ok(
      !listed.body.result.tools.some(
        (tool: { name: string }) => tool.name === name,
      ),
    );
  const denied = await app.mcp("tools/call", {
    name: "workflow.create_approval",
    arguments: {
      client_id: client,
      summary: "Hosted env must not create a card",
      idempotency_key: "hosted-env-blocked",
    },
  });
  assert.equal(denied.body.result.structuredContent.status, "rejected");
  assert.equal(store.approvals().length, 0);
  assert.equal(
    (store.db.prepare("SELECT count(*) AS count FROM receipts").get() as {
      count: number;
    }).count,
    0,
  );
});
