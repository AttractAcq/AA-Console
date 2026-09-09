import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { distributionManager as config } from "../src/onboarding/distribution-manager.js";
import { grants } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import type { Adapter } from "../src/shared/types.js";
import {
  assertDistributionDiscovery,
  runDistributionGate,
  type DistributionFixtures,
} from "../scripts/distribution-gate.js";

const id = (n: number) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
const f: DistributionFixtures = {
  approved_safe_fixtures: true, client_id: id(1), brief_id: id(2),
  approved_asset_id: id(3), pending_asset_id: id(4),
  denied_client_id: id(5), denied_task_id: id(6), denied_asset_id: id(7),
  assignee: "bot_distribution",
};
const identity = { bot: "bot_distribution" as const, clients: [f.client_id] };

test("locked 6 reads / 6 writes / 2 granted-stub allowlist; exact discovery rejects missing and unexpected tools", () => {
  assert.equal(config.reads.length, 6);
  assert.equal(config.writes.length, 6);
  assert.equal(config.stubs.length, 2);
  assert.deepEqual(grants.bot_distribution, [...config.grants]);
  assertDistributionDiscovery(config.expectedDiscovery);
  assert.throws(() => assertDistributionDiscovery(config.expectedDiscovery.slice(1)));
  assert.throws(() => assertDistributionDiscovery([...config.expectedDiscovery, "delivery.list_clients"]));
  assert.throws(() => assertDistributionDiscovery([...config.expectedDiscovery.slice(1), "content.approve_asset"]));
  for (const name of config.reads) assert.equal(registry.find(t => t.name === name)?.action, "read");
  for (const name of config.writes) assert.equal(registry.find(t => t.name === name)?.action, "write");
  for (const name of config.stubs) assert.equal(registry.find(t => t.name === name)?.implementation, "stub");
  assert.equal(registry.find(t => t.name === "content.queue_distribution")?.implementation, "real");
  assert.equal(registry.find(t => t.name === "content.record_publication")?.implementation, "real");
  assert.equal(registry.find(t => t.name === "content.queue_distribution")?.risk, "MEDIUM");
  assert.equal(registry.find(t => t.name === "content.queue_distribution")?.approval, false);
  assert.equal(registry.find(t => t.name === "content.record_publication")?.risk, "MEDIUM");
});

test("Distribution ceiling constrains stale db wildcards, explicit excess grants, and the stub debug flag before AA", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); let calls = 0;
  const adapter: Adapter = { execute: async (tool) => { calls++; return { status: "completed", capability: tool.name }; } };
  const engineStubs = new ActionEngine(store, registry, adapter, true);
  const engineDefault = new ActionEngine(store, registry, adapter, false);
  for (const caller of [identity, { ...identity, permissions: registry.map(t => `${t.domain}.*`) },
    { ...identity, permissions: registry.map(t => t.name) }]) {
    assert.deepEqual(
      [...new Set(engineStubs.discover(caller).map(t => t.name))].sort(),
      [...config.grants].sort(),
      "MCP_DISCOVER_STUBS=true must still stop at Distribution's granted ceiling",
    );
    assertDistributionDiscovery(engineDefault.discover(caller).map(t => t.name));
    for (const tool of registry.filter(t => !config.grants.some(n => n === t.name)))
      assert.equal((await engineDefault.call(caller, tool.name, { client_id: f.client_id })).status, "rejected", tool.name);
  }
  assert.equal(calls, 0);
  assert.equal(engineDefault.discover({ ...identity, permissions: [] }).length, 0);
  assert.deepEqual(
    engineDefault.discover({ ...identity, permissions: ["content.get_brief"] }).map(t => t.name),
    ["content.get_brief"],
  );
});

test("all 12 real Distribution tools deny other-client before adapter or approval creation", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); let calls = 0;
  const engine = new ActionEngine(store, registry, { execute: async tool => { calls++; return { status: "completed", capability: tool.name }; } });
  for (const name of config.expectedDiscovery) {
    const raw = {
      client_id: f.denied_client_id, asset_id: f.pending_asset_id, brief_id: f.brief_id,
      schedule_id: id(9), task_id: id(10), title: "fixture", summary: "fixture", assignee: f.assignee,
      scheduled_for: "2026-12-01", channel: "organic", status: "published", external_id: "ext",
      idempotency_key: "isolation-fixture",
    };
    const shape = (registry.find(t => t.name === name)!.input as any).shape;
    const r = await engine.call(identity, name, Object.fromEntries(Object.entries(raw).filter(([key]) => key in shape)));
    assert.equal(r.message, "Client scope denied.", name);
  }
  assert.equal(calls, 0); assert.equal(store.approvals().length, 0);
});

test("Gate 10 runs the schedule -> record-publication -> read cycle through the engine, verifies replay and Distribution audit identity", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); const hits: string[] = [];
  let task = { id: id(10), status: "open", assignee: "" };
  let schedule: Record<string, unknown> | null = null;
  const engine = new ActionEngine(store, registry, {
    execute: async (tool, input) => {
      hits.push(tool.name);
      if (tool.name === "content.queue_distribution") {
        if (input.asset_id === f.pending_asset_id)
          return { status: "failed", capability: tool.name, error: { code: "invalid_asset_status" } };
        schedule = {
          id: id(11), asset_id: input.asset_id, scheduled_for: input.scheduled_for,
          channel: input.channel ?? "organic", publication_status: "scheduled",
        };
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, asset_id: input.asset_id, schedule_id: schedule.id,
            scheduled_for: schedule.scheduled_for, channel: schedule.channel,
            publication_status: "scheduled", created_by_bot: "bot_distribution" },
        };
      }
      if (tool.name === "content.record_publication") {
        schedule = { ...(schedule as Record<string, unknown>), publication_status: input.status, external_id: input.external_id ?? null };
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, schedule_id: input.schedule_id, asset_id: (schedule as any).asset_id,
            publication_status: input.status, external_id: (schedule as any).external_id ?? null,
            published_by_bot: "bot_distribution" },
        };
      }
      if (tool.name === "content.get_production_status") {
        if (input.asset_id === f.denied_asset_id)
          return { status: "failed", capability: tool.name, error: { code: "client_mismatch" } };
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, distribution: schedule ? [schedule] : [],
            handoff: { ready_for_distribution: true } },
        };
      }
      if (tool.name === "workflow.get_task" && input.task_id === f.denied_task_id)
        return { status: "failed", capability: tool.name, error: { code: "client_mismatch" } };
      if (tool.name === "workflow.assign_task") task.assignee = String(input.assignee);
      if (tool.name === "workflow.complete_task") task.status = "complete";
      return { status: "completed", capability: tool.name, data: { client_id: f.client_id, task: { ...task } } };
    },
  });
  await runDistributionGate((name, input) => engine.call(identity, name, input), f);
  for (const name of config.writes.filter(n => n !== "workflow.create_approval"))
    assert.ok(hits.includes(name), `${name}: must execute at least once`);
  assert.equal(store.approvals().length, 1);
  assert.equal(store.approvals()[0].status, "pending");
  assert.ok(!hits.includes("workflow.record_decision"));
});

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

test("Phase 10: content.queue_distribution and content.record_publication complete through the AA adapter for bot_distribution only", async (t) => {
  const client = f.client_id;
  const asset = f.approved_asset_id;
  const schedule = id(12);
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/content/queue-distribution")
      return {
        status: 200,
        body: { client_id: client, asset_id: asset, schedule_id: schedule, scheduled_for: body.scheduled_for,
          channel: body.channel ?? "organic", publication_status: "scheduled", created_by_bot: "bot_distribution", replayed: false },
      };
    if (url === "/internal/mcp/content/record-publication")
      return {
        status: 200,
        body: { client_id: client, schedule_id: body.schedule_id, asset_id: asset, publication_status: body.status,
          external_id: body.external_id ?? null, published_by_bot: "bot_distribution", replayed: false },
      };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const scheduled = await engine.call(identity, "content.queue_distribution", {
    client_id: client, asset_id: asset, scheduled_for: "2026-12-01", channel: "organic",
    idempotency_key: "sched-0001",
  });
  assert.equal(scheduled.status, "completed");
  assert.equal(received[0]?.url, "/internal/mcp/content/queue-distribution");
  assert.deepEqual(received[0]?.body, { client_id: client, asset_id: asset, scheduled_for: "2026-12-01", channel: "organic" });
  const published = await engine.call(identity, "content.record_publication", {
    client_id: client, schedule_id: schedule, status: "published", external_id: "meta-123",
    idempotency_key: "pub-0001",
  });
  assert.equal(published.status, "completed");
  assert.equal(received[1]?.url, "/internal/mcp/content/record-publication");
  assert.deepEqual(received[1]?.body, { client_id: client, schedule_id: schedule, status: "published", external_id: "meta-123" });
  assert.equal((published.data as any).published_by_bot, "bot_distribution");

  // Sec Phase 10 hard gate: not expressible by withholding a grant, since
  // bot_production already has content.* for its other real content tools.
  const production = { bot: "bot_production" as const, clients: [client] };
  const productionDenied = await engine.call(production, "content.queue_distribution", {
    client_id: client, asset_id: asset, scheduled_for: "2026-12-01", idempotency_key: "sched-prod-denied",
  });
  assert.equal(productionDenied.status, "rejected");
  assert.equal(productionDenied.message, "Tool unavailable or unauthorized.");
  const productionPublishDenied = await engine.call(production, "content.record_publication", {
    client_id: client, schedule_id: schedule, status: "published", idempotency_key: "pub-prod-denied",
  });
  assert.equal(productionPublishDenied.status, "rejected");
  assert.equal(received.length, 2);
});

test("gateway denies other-client and unauthorized bots before AA for both real distribution tools", async (t) => {
  let hits = 0;
  const { adapter } = await mockAa(t, () => { hits += 1; return { status: 200, body: { client_id: f.client_id } }; });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const other = id(20);
  const inputs: Record<string, Record<string, unknown>> = {
    "content.queue_distribution": {
      client_id: other, asset_id: f.approved_asset_id, scheduled_for: "2026-12-01",
      idempotency_key: "scope-sched",
    },
    "content.record_publication": {
      client_id: other, schedule_id: id(13), status: "published", idempotency_key: "scope-pub",
    },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const result = await engine.call(identity, name, input);
    assert.equal(result.status, "rejected", name);
    assert.equal(result.message, "Client scope denied.", name);
  }
  assert.equal(hits, 0);
  const marketing = { bot: "bot_marketing" as const, clients: [f.client_id] };
  for (const [name, input] of Object.entries(inputs)) {
    const result = await engine.call(marketing, name, { ...input, client_id: f.client_id });
    assert.equal(result.status, "rejected", name);
  }
  assert.equal(hits, 0);
});
