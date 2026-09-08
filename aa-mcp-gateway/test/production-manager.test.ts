import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const idea = "33333333-3333-4333-8333-333333333333";
const brief = "44444444-4444-4444-8444-444444444444";
const asset = "55555555-5555-4555-8555-555555555555";
const job = "66666666-6666-4666-8666-666666666666";
const identity = { bot: "bot_production" as const, clients: [client] };

async function mockAa(
  t: any,
  handler: (req: { url?: string; body: any }) => { status: number; body: unknown },
) {
  const received: { url?: string; method?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    received.push({ url: req.url, method: req.method, body });
    const result = handler({ url: req.url, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
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
    timeoutMs: 1000,
  });
  return { adapter, received };
}

test("Phase 5 tools are real and generate_brief stays accepted", async (t) => {
  const real = registry
    .filter((x) => x.implementation === "real")
    .map((x) => x.name)
    .sort();
  for (const name of [
    "content.list_ideas",
    "content.get_idea",
    "content.generate_brief",
    "content.get_brief",
    "content.request_revision",
    "content.get_production_status",
    "content.create_repurpose_plan",
    "content.request_approval",
  ])
    assert.ok(real.includes(name), name);
  assert.equal(
    registry.find((x) => x.name === "content.approve_asset")?.implementation,
    "stub",
  );
  assert.equal(
    registry.find((x) => x.name === "content.queue_distribution")?.implementation,
    "stub",
  );
  const { adapter, received } = await mockAa(t, ({ url }) => {
    if (url === "/internal/mcp/content/generate-brief")
      return { status: 202, body: { job_id: job, client_id: client } };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const result = await new ActionEngine(store, registry, adapter).call(
    identity,
    "content.generate_brief",
    { client_id: client, idea_id: idea, idempotency_key: "brief-keep" },
  );
  assert.equal(result.status, "accepted");
  assert.equal(received[0]?.url, "/internal/mcp/content/generate-brief");
  assert.deepEqual(received[0]?.body, { client_id: client, idea_id: idea });
});

test("list_ideas and get_idea complete through the AA adapter", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url }) => {
    if (url === "/internal/mcp/content/list-ideas")
      return {
        status: 200,
        body: { client_id: client, ideas: [{ id: idea, title: "A" }], count: 1 },
      };
    if (url === "/internal/mcp/content/get-idea")
      return { status: 200, body: { client_id: client, id: idea, title: "A" } };
    return { status: 500, body: { error: { code: "internal_error" } } };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const listed = await engine.call(identity, "content.list_ideas", {
    client_id: client,
    status: "approved",
  });
  assert.equal(listed.status, "completed");
  assert.equal((listed.data as any).count, 1);
  assert.equal(received[0]?.url, "/internal/mcp/content/list-ideas");
  const got = await engine.call(identity, "content.get_idea", {
    client_id: client,
    idea_id: idea,
  });
  assert.equal(got.status, "completed");
  assert.equal(
    (
      await engine.call(identity, "content.list_ideas", { client_id: other })
    ).status,
    "rejected",
  );
});

test("get_brief and production status require a resource id", async (t) => {
  const { adapter } = await mockAa(t, () => ({
    status: 200,
    body: { client_id: client, id: brief },
  }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  assert.equal(
    (await engine.call(identity, "content.get_brief", { client_id: client }))
      .status,
    "failed",
  );
  const ok = await engine.call(identity, "content.get_brief", {
    client_id: client,
    idea_id: idea,
  });
  assert.equal(ok.status, "completed");
});

test("request_revision and request_approval are completed writes", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url }) => {
    if (url?.includes("revision"))
      return {
        status: 200,
        body: { client_id: client, brief_id: brief, brief_status: "draft" },
      };
    return {
      status: 200,
      body: { client_id: client, queue: "console_approvals" },
    };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const revision = await engine.call(identity, "content.request_revision", {
    client_id: client,
    brief_id: brief,
    summary: "Hook is weak",
    idempotency_key: "rev-0001",
  });
  assert.equal(revision.status, "completed");
  assert.equal(received[0]?.url, "/internal/mcp/content/request-revision");
  const approval = await engine.call(identity, "content.request_approval", {
    client_id: client,
    asset_id: asset,
    idempotency_key: "appr-0001",
  });
  assert.equal(approval.status, "completed");
  assert.equal((approval.data as any).queue, "console_approvals");
});

test("create_repurpose_plan is accepted and does not mint other-bot calls", async (t) => {
  const { adapter, received } = await mockAa(t, () => ({
    status: 202,
    body: { job_id: job, client_id: client, asset_id: asset, formats: ["reel"] },
  }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const result = await engine.call(identity, "content.create_repurpose_plan", {
    client_id: client,
    asset_id: asset,
    formats: ["reel"],
    idempotency_key: "repurpose-001",
  });
  assert.equal(result.status, "accepted");
  assert.equal(received[0]?.url, "/internal/mcp/content/create-repurpose-plan");
  assert.deepEqual(received[0]?.body, {
    client_id: client,
    asset_id: asset,
    formats: ["reel"],
  });
  const finance = { bot: "bot_finance" as const, clients: [client] };
  assert.equal(
    (
      await engine.call(finance, "content.create_repurpose_plan", {
        client_id: client,
        asset_id: asset,
        formats: ["reel"],
        idempotency_key: "finance-no",
      })
    ).status,
    "rejected",
  );
});
