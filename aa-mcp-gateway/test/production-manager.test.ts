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
    "content.select_idea",
    "content.approve_asset",
  ])
    assert.ok(real.includes(name), name);
  assert.equal(
    registry.find((x) => x.name === "content.queue_distribution")?.implementation,
    "stub",
  );
  assert.equal(
    registry.find((x) => x.name === "content.approve_asset")?.risk,
    "MEDIUM",
  );
  assert.equal(
    registry.find((x) => x.name === "content.approve_asset")?.approval,
    false,
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

test("Phase 9b: content.select_idea and content.approve_asset complete through the AA adapter for bot_production only", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/content/select-idea")
      return {
        status: 200,
        body: { client_id: client, idea_id: idea, idea_status: "approved", replayed: false },
      };
    if (url === "/internal/mcp/content/approve-asset")
      return {
        status: 200,
        body: {
          client_id: client, asset_id: asset, decision: body.decision,
          reviewed_by_bot: "bot_production", replayed: false,
        },
      };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const approvedIdea = await engine.call(identity, "content.select_idea", {
    client_id: client,
    idea_id: idea,
    idempotency_key: "idea-0001",
  });
  assert.equal(approvedIdea.status, "completed");
  assert.equal(received[0]?.url, "/internal/mcp/content/select-idea");
  assert.deepEqual(received[0]?.body, { client_id: client, idea_id: idea });
  const decided = await engine.call(identity, "content.approve_asset", {
    client_id: client,
    asset_id: asset,
    decision: "approved",
    idempotency_key: "asset-0001",
  });
  assert.equal(decided.status, "completed");
  assert.equal(received[1]?.url, "/internal/mcp/content/approve-asset");
  assert.deepEqual(received[1]?.body, {
    client_id: client, asset_id: asset, decision: "approved",
  });
  assert.equal((decided.data as any).reviewed_by_bot, "bot_production");

  // Sec Phase 9b hard gate: not expressible by withholding a grant, since
  // bot_marketing already has content.* for its other real content tools.
  const marketing = { bot: "bot_marketing" as const, clients: [client] };
  const marketingDenied = await engine.call(marketing, "content.approve_asset", {
    client_id: client,
    asset_id: asset,
    decision: "approved",
    idempotency_key: "asset-marketing-denied",
  });
  assert.equal(marketingDenied.status, "rejected");
  assert.equal(marketingDenied.message, "Tool unavailable or unauthorized.");
  const marketingIdeaDenied = await engine.call(marketing, "content.select_idea", {
    client_id: client,
    idea_id: idea,
    idempotency_key: "idea-marketing-denied",
  });
  assert.equal(marketingIdeaDenied.status, "rejected");
  assert.equal(received.length, 2);
});

test("gateway denies other-client and unauthorized bots before AA for every real content tool", async (t) => {
  let hits = 0;
  const { adapter } = await mockAa(t, () => {
    hits += 1;
    return { status: 200, body: { client_id: client } };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const realContent = registry
    .filter((x) => x.name.startsWith("content.") && x.implementation === "real")
    .map((x) => x.name)
    .sort();
  assert.deepEqual(realContent, [
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
  ]);
  const inputs: Record<string, Record<string, unknown>> = {
    "content.list_ideas": { client_id: other, status: "approved" },
    "content.get_idea": { client_id: other, idea_id: idea },
    "content.generate_brief": {
      client_id: other,
      idea_id: idea,
      idempotency_key: "scope-brief",
    },
    "content.get_brief": { client_id: other, idea_id: idea },
    "content.get_production_status": { client_id: other, idea_id: idea },
    "content.request_revision": {
      client_id: other,
      brief_id: brief,
      summary: "No",
      idempotency_key: "scope-rev",
    },
    "content.request_approval": {
      client_id: other,
      asset_id: asset,
      idempotency_key: "scope-appr",
    },
    "content.create_repurpose_plan": {
      client_id: other,
      asset_id: asset,
      formats: ["reel"],
      idempotency_key: "scope-rep",
    },
    "content.select_idea": {
      client_id: other,
      idea_id: idea,
      idempotency_key: "scope-idea",
    },
    "content.approve_asset": {
      client_id: other,
      asset_id: asset,
      decision: "approved",
      idempotency_key: "scope-asset",
    },
  };
  for (const name of realContent) {
    const result = await engine.call(identity, name, inputs[name]);
    assert.equal(result.status, "rejected", name);
    assert.equal(result.message, "Client scope denied.", name);
  }
  assert.equal(hits, 0);
  const finance = { bot: "bot_finance" as const, clients: [client] };
  for (const name of [
    "content.request_revision",
    "content.request_approval",
    "content.create_repurpose_plan",
    "content.generate_brief",
    "content.select_idea",
    "content.approve_asset",
  ]) {
    const result = await engine.call(finance, name, {
      ...inputs[name],
      client_id: client,
    });
    assert.equal(result.status, "rejected", name);
  }
  assert.equal(
    (
      await engine.call(identity, "workflow.record_decision", {
        client_id: client,
        approval_id: client,
        decision: "approved",
        idempotency_key: "no-decision",
      })
    ).status,
    "rejected",
  );
  assert.equal(hits, 0);
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

test("Phase 6 carries the root approval execution through continuation and denies before AA", async (t) => {
  const { adapter, received } = await mockAa(t, ({ body }) => ({
    status: 202, body: { client_id: client, job_id: job, approval_execution_id: body.approval_execution_id },
  }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const input = { client_id: client, asset_id: asset, formats: ["reel"], approval_execution_id: "approval-root", idempotency_key: "resume-key" };
  const ok = await engine.call(identity, "content.create_repurpose_plan", input);
  assert.equal(ok.status, "accepted");
  assert.equal((ok.data as any).approval_execution_id, "approval-root");
  assert.deepEqual(received[0]?.body, { client_id: client, asset_id: asset, formats: ["reel"], approval_execution_id: "approval-root" });
  assert.equal((await engine.call(identity, "content.create_repurpose_plan", input)).status, "accepted");
  assert.equal(received.length, 1);
  for (const denied of [{ ...input, client_id: other }, { ...input, approval_execution_id: "bad root" }, { ...input, approval_execution_id: null }]) {
    assert.equal((await engine.call(identity, "content.create_repurpose_plan", denied)).status, "rejected");
  }
  const wildcard = { ...identity, permissions: ["workflow.*", "content.*"] };
  assert.equal((await engine.call(wildcard, "workflow.record_decision", {
    client_id: client, approval_id: asset, decision: "approved", idempotency_key: "no-decide",
  })).status, "rejected");
  // Phase 9b: bot_production-only hard gate, even for a Bot with a wildcard
  // content.* grant (Marketing keeps content.* for its other real tools).
  const marketing = { bot: "bot_marketing" as const, clients: [client] };
  assert.equal((await engine.call(marketing, "content.approve_asset", {
    client_id: client, asset_id: asset, decision: "approved", idempotency_key: "no-asset-decide",
  })).status, "rejected");
  assert.equal((await engine.call(marketing, "content.select_idea", {
    client_id: client, idea_id: idea, idempotency_key: "no-idea-decide",
  })).status, "rejected");
  assert.equal(received.length, 1);
});

test("Phase 6 approval-required errors are preserved and status returns the AA trail", async (t) => {
  const trail = [{ execution_id: "approval-root", state: "approved", decision: { decision: "approved" } }];
  const { adapter } = await mockAa(t, ({ url }) => url?.endsWith("get-production-status")
    ? { status: 200, body: { client_id: client, approvals: trail, handoff: { ready_for_distribution: true } } }
    : { status: 409, body: { error: { code: "approval_required" } } });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const waiting = await engine.call(identity, "content.create_repurpose_plan", {
    client_id: client, asset_id: asset, formats: ["reel"], approval_execution_id: "approval-root", idempotency_key: "waiting-resume",
  });
  assert.equal(waiting.status, "failed");
  assert.equal(waiting.error?.code, "approval_required");
  const status = await engine.call(identity, "content.get_production_status", { client_id: client, asset_id: asset });
  assert.deepEqual((status.data as any).approvals, trail);
});
