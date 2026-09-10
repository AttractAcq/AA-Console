import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { salesOps } from "../src/onboarding/sales-ops.js";
import {
  assertSalesOpsDiscovery,
  runSalesOpsGate,
  runSalesAgentFactoryGate,
  type SalesOpsFixtures,
} from "../scripts/sales-ops-gate.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const lead = "33333333-3333-4333-8333-333333333333";
const agent = "44444444-4444-4444-8444-444444444444";
const identity = { bot: "bot_sales_ops" as const, clients: [client] };

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

test("Phase 11b: exact discovery set equality for bot_sales_ops (22 = Phase 11's 17 + factory's 5)", () => {
  const engine = new ActionEngine(new Store(":memory:"), registry, new AAApiAdapter());
  const discovered = engine.discover(identity).map((t) => t.name);
  assert.deepEqual(
    [...new Set(discovered)].sort(),
    [...salesOps.expectedDiscovery].sort(),
  );
  assert.equal(discovered.length, 22);
  engine.store.close();
});

test("Phase 11b: the fourteen realized pipeline/sales_agents tools are real; record_sale/deploy/proof/etc stay stub", () => {
  const real = registry
    .filter((x) => x.implementation === "real" && (x.name.startsWith("pipeline.") || x.name.startsWith("sales_agents.")))
    .map((x) => x.name)
    .sort();
  assert.deepEqual(real, [
    "pipeline.create_followup",
    "pipeline.get_lead",
    "pipeline.get_pipeline_summary",
    "pipeline.get_stalled_leads",
    "pipeline.list_leads",
    "pipeline.update_stage",
    "sales_agents.create",
    "sales_agents.generate_config",
    "sales_agents.get",
    "sales_agents.get_conversations",
    "sales_agents.list",
    "sales_agents.test",
    "sales_agents.update_knowledge",
    "sales_agents.update_qualification_rules",
  ]);
  for (const name of ["pipeline.record_sale", "sales_agents.deploy"]) {
    assert.equal(registry.find((x) => x.name === name)?.implementation, "stub", name);
  }
  assert.equal(registry.find((x) => x.name === "sales_agents.deploy")?.risk, "CRITICAL");
  assert.equal(registry.find((x) => x.name === "sales_agents.deploy")?.approval, true);
  assert.equal(registry.find((x) => x.name === "pipeline.record_sale")?.approval, true);
  // Sec-bar #9: update_stage/create_followup and the 5 factory writes were
  // never on the gateway HIGH approval array; MEDIUM + AA-RPC-only
  // authorization, same posture Phase 9b/10/11 settled on.
  for (const name of ["pipeline.update_stage", "pipeline.create_followup",
    "sales_agents.generate_config", "sales_agents.create", "sales_agents.update_knowledge",
    "sales_agents.update_qualification_rules", "sales_agents.test"]) {
    assert.equal(registry.find((x) => x.name === name)?.risk, "MEDIUM", name);
    assert.equal(registry.find((x) => x.name === name)?.approval, false, name);
  }
  for (const name of ["pipeline.list_leads", "pipeline.get_lead", "pipeline.get_stalled_leads",
    "pipeline.get_pipeline_summary", "sales_agents.list", "sales_agents.get", "sales_agents.get_conversations"]) {
    assert.equal(registry.find((x) => x.name === name)?.risk, "LOW", name);
  }
});

test("pipeline reads complete through the AA adapter", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url }) => {
    if (url === "/internal/mcp/pipeline/list-leads")
      return { status: 200, body: { client_id: client, leads: [{ id: lead }], count: 1 } };
    if (url === "/internal/mcp/pipeline/get-lead")
      return { status: 200, body: { client_id: client, id: lead, stage: "lead" } };
    if (url === "/internal/mcp/pipeline/get-stalled-leads")
      return { status: 200, body: { client_id: client, stalled_leads: [], count: 0 } };
    if (url === "/internal/mcp/pipeline/get-pipeline-summary")
      return { status: 200, body: { client_id: client, by_stage: [], total_leads: 0 } };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const listed = await engine.call(identity, "pipeline.list_leads", { client_id: client });
  assert.equal(listed.status, "completed");
  assert.equal(received[0]?.url, "/internal/mcp/pipeline/list-leads");
  const got = await engine.call(identity, "pipeline.get_lead", { client_id: client, lead_id: lead });
  assert.equal(got.status, "completed");
  const stalled = await engine.call(identity, "pipeline.get_stalled_leads", { client_id: client, days: 14 });
  assert.equal(stalled.status, "completed");
  const summary = await engine.call(identity, "pipeline.get_pipeline_summary", { client_id: client });
  assert.equal(summary.status, "completed");
  assert.equal(
    (await engine.call(identity, "pipeline.list_leads", { client_id: other })).status,
    "rejected",
  );
});

test("pipeline.update_stage and pipeline.create_followup are completed writes; sale/cash target stages are rejected before AA", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/pipeline/update-stage")
      return { status: 200, body: { client_id: client, lead_id: lead, from_stage: "lead", stage: body.stage, replayed: false } };
    if (url === "/internal/mcp/pipeline/create-followup")
      return { status: 200, body: { client_id: client, lead_id: lead, next_action: body.next_action, replayed: false } };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const staged = await engine.call(identity, "pipeline.update_stage", {
    client_id: client, lead_id: lead, stage: "conversation", idempotency_key: "stage-0001",
  });
  assert.equal(staged.status, "completed");
  assert.deepEqual(received[0]?.body, { client_id: client, lead_id: lead, stage: "conversation" });
  const followup = await engine.call(identity, "pipeline.create_followup", {
    client_id: client, lead_id: lead, next_action: "Call back Thursday", idempotency_key: "followup-0001",
  });
  assert.equal(followup.status, "completed");
  assert.equal(received[1]?.url, "/internal/mcp/pipeline/create-followup");

  for (const stage of ["sale", "cash"]) {
    const denied = await engine.call(identity, "pipeline.update_stage", {
      client_id: client, lead_id: lead, stage, idempotency_key: `no-stage-${stage}`,
    });
    assert.equal(denied.status, "rejected", stage);
    assert.equal(denied.message, "Invalid tool input.", stage);
  }
  assert.equal(received.length, 2);
});

test("sales_agents reads complete through the AA adapter", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url }) => {
    if (url === "/internal/mcp/sales-agents/list")
      return { status: 200, body: { client_id: client, sales_agents: [{ id: agent }], count: 1 } };
    if (url === "/internal/mcp/sales-agents/get")
      return { status: 200, body: { client_id: client, id: agent, name: "Closer" } };
    if (url === "/internal/mcp/sales-agents/get-conversations")
      return { status: 200, body: { client_id: client, conversations: [], count: 0 } };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  assert.equal((await engine.call(identity, "sales_agents.list", { client_id: client })).status, "completed");
  assert.equal((await engine.call(identity, "sales_agents.get", { client_id: client, sales_agent_id: agent })).status, "completed");
  assert.equal((await engine.call(identity, "sales_agents.get_conversations", { client_id: client })).status, "completed");
  assert.equal(received.length, 3);
});

test("sales_agents factory writes complete through the AA adapter; deploy stays not_implemented", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/sales-agents/generate-config")
      return { status: 200, body: { client_id: client, role: body.role, draft: { qualification: [{ question: "x" }] } } };
    if (url === "/internal/mcp/sales-agents/create")
      return { status: 200, body: { client_id: client, id: agent, role: body.role, status: "draft", replayed: false } };
    if (url === "/internal/mcp/sales-agents/update-knowledge")
      return { status: 200, body: { client_id: client, id: agent, guardrails: body.guardrails, replayed: false } };
    if (url === "/internal/mcp/sales-agents/update-qualification-rules")
      return { status: 200, body: { client_id: client, id: agent, qualification: body.qualification, replayed: false } };
    if (url === "/internal/mcp/sales-agents/test")
      return { status: 200, body: { client_id: client, sandbox: true, live_channel_send: false, replayed: false } };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const generated = await engine.call(identity, "sales_agents.generate_config", {
    client_id: client, role: "inbound_qualifier", idempotency_key: "gen-00001",
  });
  assert.equal(generated.status, "completed");
  const created = await engine.call(identity, "sales_agents.create", {
    client_id: client, role: "inbound_qualifier", name: "Front Desk", purpose: "Qualify and book",
    idempotency_key: "create-0001",
  });
  assert.equal(created.status, "completed");
  const knowledge = await engine.call(identity, "sales_agents.update_knowledge", {
    client_id: client, sales_agent_id: agent, guardrails: "Never quote a price.",
    idempotency_key: "know-00001",
  });
  assert.equal(knowledge.status, "completed");
  const rules = await engine.call(identity, "sales_agents.update_qualification_rules", {
    client_id: client, sales_agent_id: agent,
    qualification: [{ question: "What is your timeline?" }],
    idempotency_key: "rules-0001",
  });
  assert.equal(rules.status, "completed");
  const tested = await engine.call(identity, "sales_agents.test", {
    client_id: client, sales_agent_id: agent,
    transcript: [{ role: "lead", text: "Hi" }],
    idempotency_key: "test-00001",
  });
  assert.equal(tested.status, "completed");
  assert.equal(received.length, 5);

  const deployed = await engine.call(identity, "sales_agents.deploy", {
    client_id: client, sales_agent_id: agent, idempotency_key: "deploy-0001",
  });
  assert.equal(deployed.status, "rejected");
  assert.equal(received.length, 5, "deploy must never reach the AA adapter");
});

test("gateway denies other-client before AA for every real Sales Ops tool", async (t) => {
  let hits = 0;
  const { adapter } = await mockAa(t, () => {
    hits += 1;
    return { status: 200, body: { client_id: client } };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const inputs: Record<string, Record<string, unknown>> = {
    "pipeline.list_leads": {},
    "pipeline.get_lead": { lead_id: lead },
    "pipeline.get_stalled_leads": {},
    "pipeline.get_pipeline_summary": {},
    "pipeline.update_stage": { lead_id: lead, stage: "conversation", idempotency_key: "scope-stage" },
    "pipeline.create_followup": { lead_id: lead, next_action: "x", idempotency_key: "scope-fu" },
    "sales_agents.list": {},
    "sales_agents.get": { sales_agent_id: agent },
    "sales_agents.get_conversations": {},
    "sales_agents.generate_config": { role: "inbound_qualifier", idempotency_key: "scope-gen" },
    "sales_agents.create": { role: "inbound_qualifier", name: "x", purpose: "y", idempotency_key: "scope-create" },
    "sales_agents.update_knowledge": { sales_agent_id: agent, guardrails: "x", idempotency_key: "scope-know" },
    "sales_agents.update_qualification_rules": {
      sales_agent_id: agent, qualification: [{ question: "x" }], idempotency_key: "scope-rules",
    },
    "sales_agents.test": {
      sales_agent_id: agent, transcript: [{ role: "lead", text: "x" }], idempotency_key: "scope-test",
    },
  };
  for (const [name, extra] of Object.entries(inputs)) {
    const result = await engine.call(identity, name, { client_id: other, ...extra });
    assert.equal(result.status, "rejected", name);
    assert.equal(result.message, "Client scope denied.", name);
  }
  assert.equal(hits, 0);
});

test("forbidden/deferred tools are absent from discovery and denied if called", async (t) => {
  let hits = 0;
  const { adapter } = await mockAa(t, () => {
    hits += 1;
    return { status: 200, body: { client_id: client } };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const discovered = new Set(engine.discover(identity).map((t) => t.name));
  const forbidden = [
    "pipeline.record_sale",
    "sales_agents.deploy",
    "proof.search", "proof.get",
    "content.select_idea", "content.approve_asset", "content.queue_distribution",
    "content.record_publication", "content.generate_brief", "content.list_ideas",
    "campaign.create", "campaign.update", "campaign.request_approval", "campaign.list",
    "economics.get_client_economics", "security.get_system_status",
    "engineering.get_deployment_status", "engineering.create_issue",
    "workflow.record_decision",
  ];
  for (const name of forbidden) {
    assert.ok(!discovered.has(name), `${name} must not be discoverable by bot_sales_ops`);
    const result = await engine.call(identity, name, { client_id: client, idempotency_key: "no-go" });
    assert.equal(result.status, "rejected", name);
    assert.equal(result.message, "Tool unavailable or unauthorized.", name);
  }
  assert.equal(hits, 0);

  // Belt-and-suspenders: a synthetic wildcard permission set (as if a stale DB
  // row granted pipeline.*/sales_agents.* back) must still be capped by the
  // exact-allowlist ceiling in permissions.ts allowed().
  const wildcard = { ...identity, permissions: ["pipeline.*", "sales_agents.*", ...salesOps.grants] };
  for (const name of ["pipeline.record_sale", "sales_agents.deploy"]) {
    const result = await engine.call(wildcard, name, { client_id: client, idempotency_key: "wildcard-no-go" });
    assert.equal(result.status, "rejected", name);
  }
  assert.equal(hits, 0);
});

test("Gate 11b fixtures exercise the exact 22-tool discovery set", () => {
  assertSalesOpsDiscovery(salesOps.expectedDiscovery);
  assert.throws(() => assertSalesOpsDiscovery(salesOps.expectedDiscovery.slice(1)));
  assert.throws(() => assertSalesOpsDiscovery([...salesOps.expectedDiscovery, "pipeline.record_sale"]));
  assert.throws(() => assertSalesOpsDiscovery([...salesOps.expectedDiscovery.slice(1), "sales_agents.deploy"]));
});

test("Gate 11 runs the lead-read -> stage-move -> follow-up -> workflow-task cycle through the engine, verifies replay and Sales Ops audit identity", async (t) => {
  const id = (n: number) => `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
  const f: SalesOpsFixtures = {
    approved_safe_fixtures: true, client_id: id(1), lead_id: id(2), sales_agent_id: id(3),
    denied_client_id: id(4), denied_lead_id: id(5), denied_task_id: id(6),
    assignee: "bot_sales_ops",
  };
  const gateIdentity = { bot: "bot_sales_ops" as const, clients: [f.client_id] };
  const store = new Store(":memory:");
  t.after(() => store.close());
  const hits: string[] = [];
  let task = { id: id(7), status: "open", assignee: "" };
  const engine = new ActionEngine(store, registry, {
    execute: async (tool, input) => {
      hits.push(tool.name);
      if (tool.name === "pipeline.get_lead") {
        if (input.lead_id === f.denied_lead_id)
          return { status: "failed", capability: tool.name, error: { code: "client_mismatch" } };
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, id: input.lead_id, stage: "lead" } };
      }
      if (tool.name === "pipeline.list_leads")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, leads: [], count: 0 } };
      if (tool.name === "pipeline.get_stalled_leads")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, stalled_leads: [], count: 0 } };
      if (tool.name === "pipeline.get_pipeline_summary")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, by_stage: [], total_leads: 0 } };
      if (tool.name === "pipeline.update_stage")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, lead_id: input.lead_id, from_stage: "lead", stage: input.stage, replayed: false },
        };
      if (tool.name === "pipeline.create_followup")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, lead_id: input.lead_id, next_action: input.next_action, replayed: false },
        };
      if (tool.name === "sales_agents.list")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, sales_agents: [], count: 0 } };
      if (tool.name === "sales_agents.get")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, id: input.sales_agent_id, name: "Closer" } };
      if (tool.name === "sales_agents.get_conversations")
        return { status: "completed", capability: tool.name, data: { client_id: f.client_id, conversations: [], count: 0 } };
      if (tool.name === "workflow.get_task" && input.task_id === f.denied_task_id)
        return { status: "failed", capability: tool.name, error: { code: "client_mismatch" } };
      if (tool.name === "workflow.assign_task") task.assignee = String(input.assignee);
      if (tool.name === "workflow.complete_task") task.status = "complete";
      return { status: "completed", capability: tool.name, data: { client_id: f.client_id, task: { ...task } } };
    },
  });
  await runSalesOpsGate((name, input) => engine.call(gateIdentity, name, input), f);
  for (const name of ["pipeline.update_stage", "pipeline.create_followup",
    "workflow.create_task", "workflow.assign_task", "workflow.complete_task"])
    assert.ok(hits.includes(name), `${name}: must execute at least once`);
  assert.equal(store.approvals().length, 1);
  assert.equal(store.approvals()[0].status, "pending");
  assert.ok(!hits.includes("workflow.record_decision"));
  assert.ok(!hits.includes("pipeline.record_sale"));
});

test("Gate 11b runs generate_config -> create -> update_knowledge -> update_qualification_rules -> test through the engine, and denies deploy", async (t) => {
  const id = (n: number) => `${String(n).padStart(8, "0")}-4444-4444-8444-444444444444`;
  const f: SalesOpsFixtures = {
    approved_safe_fixtures: true, client_id: id(1), lead_id: id(2), sales_agent_id: id(3),
    denied_client_id: id(4), denied_lead_id: id(5), denied_task_id: id(6),
    assignee: "bot_sales_ops",
  };
  const gateIdentity = { bot: "bot_sales_ops" as const, clients: [f.client_id] };
  const store = new Store(":memory:");
  t.after(() => store.close());
  const hits: string[] = [];
  const createdAgentId = id(7);
  const engine = new ActionEngine(store, registry, {
    execute: async (tool, input) => {
      hits.push(tool.name);
      if (tool.name === "sales_agents.generate_config")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, role: input.role, draft: { qualification: [{ question: "What is your timeline?" }] } },
        };
      if (tool.name === "sales_agents.create")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, id: createdAgentId, role: input.role, status: "draft", replayed: false },
        };
      if (tool.name === "sales_agents.update_knowledge")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, id: input.sales_agent_id, guardrails: input.guardrails, replayed: false },
        };
      if (tool.name === "sales_agents.update_qualification_rules")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, id: input.sales_agent_id, qualification: input.qualification, replayed: false },
        };
      if (tool.name === "sales_agents.test")
        return {
          status: "completed", capability: tool.name,
          data: { client_id: f.client_id, sandbox: true, live_channel_send: false, replayed: false },
        };
      throw new Error(`unexpected tool: ${tool.name}`);
    },
  });
  await runSalesAgentFactoryGate((name, input) => engine.call(gateIdentity, name, input), f);
  for (const name of ["sales_agents.generate_config", "sales_agents.create",
    "sales_agents.update_knowledge", "sales_agents.update_qualification_rules", "sales_agents.test"])
    assert.ok(hits.includes(name), `${name}: must execute at least once`);
  assert.ok(!hits.includes("sales_agents.deploy"), "deploy must never reach the AA adapter");
});

test("other bots do not gain pipeline.*/sales_agents.* access from this phase", async (t) => {
  const { adapter } = await mockAa(t, () => ({ status: 200, body: { client_id: client } }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  for (const bot of ["bot_production", "bot_marketing", "bot_distribution", "bot_chief_of_staff", "bot_client_delivery"] as const) {
    const other_identity = { bot, clients: [client] };
    for (const name of ["pipeline.list_leads", "pipeline.update_stage", "sales_agents.list", "sales_agents.create"]) {
      const result = await engine.call(other_identity, name, { client_id: client, idempotency_key: "cross-bot" });
      assert.equal(result.status, "rejected", `${bot} / ${name}`);
    }
  }
});
