import { test } from "node:test";
import assert from "node:assert/strict";
import { marketingDirector as config } from "../src/onboarding/marketing-director.js";
import { grants } from "../src/policy/permissions.js";
import { registry } from "../src/registry/tools.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { assertMarketingDiscovery, runMarketingGate, type MarketingFixtures } from "../scripts/marketing-gate.js";
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const f: MarketingFixtures = {
  approved_safe_fixtures: true, client_id: id(1), campaign_id: id(2), ad_campaign_id: id(15),
  generation_idea_id: id(3), revision_brief_id: id(4), pending_asset_id: id(5), approved_asset_id: id(6),
  page_id: id(16), finding_ids: [id(17)], revision_number: 1,
  denied_client_id: id(7), denied_task_id: id(8), denied_campaign_id: id(9), denied_asset_id: id(10),
  denied_page_id: id(18), assignee: "bot_marketing",
};
const identity = { bot: "bot_marketing" as const, clients: [f.client_id] };
const queued = new Set([
  "content.generate_brief", "content.create_repurpose_plan",
  "conversion.create_page", "conversion.generate_structure", "conversion.generate_copy",
  "conversion.audit_page", "conversion.revise_page", "campaign.create", "campaign.plan",
]);
test("locked 19 reads / 21 writes; exact discovery rejects missing and unexpected tools", () => {
  assert.equal(config.reads.length, 19); assert.equal(config.writes.length, 21);
  assert.equal(config.grants.length, 40);
  assert.equal(config.phase16Owned.length, 17);
  assert.deepEqual(grants.bot_marketing, [...config.grants]);
  assertMarketingDiscovery(config.grants);
  assert.throws(() => assertMarketingDiscovery(config.grants.slice(1)));
  assert.throws(() => assertMarketingDiscovery([...config.grants, "delivery.list_clients"]));
  assert.throws(() => assertMarketingDiscovery([...config.grants.slice(1), "content.approve_asset"]));
  for (const name of config.reads) assert.equal(registry.find(t => t.name === name)?.action, "read");
  for (const name of config.writes) assert.equal(registry.find(t => t.name === name)?.action, "write");
  for (const name of config.grants)
    assert.equal(registry.find(t => t.name === name)?.implementation, "real", name);
});
test("Marketing ceiling constrains stale db wildcards, explicit excess grants and stub debug flag before AA", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); let calls = 0;
  const engine = new ActionEngine(store, registry, { execute: async tool => { calls++; return { status: "completed", capability: tool.name }; } }, true);
  for (const caller of [identity, { ...identity, permissions: registry.map(t => `${t.domain}.*`) },
    { ...identity, permissions: registry.map(t => t.name) }]) {
    assertMarketingDiscovery(engine.discover(caller).map(t => t.name));
    for (const tool of registry.filter(t => !config.grants.some(n => n === t.name)))
      assert.equal((await engine.call(caller, tool.name, { client_id: f.client_id })).status, "rejected", tool.name);
  }
  assert.equal(calls, 0);
  assert.equal(engine.discover({ ...identity, permissions: [] }).length, 0);
  assert.deepEqual(engine.discover({ ...identity, permissions: ["campaign.get"] }).map(t => t.name), ["campaign.get"]);
});
test("all Marketing tools deny other-client before adapter or approval creation", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); let calls = 0;
  const engine = new ActionEngine(store, registry, { execute: async tool => { calls++; return { status: "completed", capability: tool.name }; } });
  for (const name of config.grants) {
    const raw = { client_id: f.denied_client_id, campaign_id: f.campaign_id,
      idea_id: f.generation_idea_id, asset_id: f.pending_asset_id, brief_id: f.revision_brief_id,
      page_id: f.page_id, finding_ids: f.finding_ids, revision_number: f.revision_number,
      name: "fixture", brief: "fixture",
      task_id: id(11), title: "fixture", summary: "fixture", assignee: f.assignee,
      formats: ["text_post"], idempotency_key: "isolation-fixture" };
    const shape = (registry.find(t => t.name === name)!.input as any).shape;
    const r = await engine.call(identity, name, Object.fromEntries(Object.entries(raw).filter(([key]) => key in shape)));
    assert.equal(r.message, "Client scope denied.", name);
  }
  assert.equal(calls, 0); assert.equal(store.approvals().length, 0);
});
test("Gate 16 runs all writes through engine, verifies replay, Marketing audit identity and pending-only approval", async t => {
  const store = new Store(":memory:"); t.after(() => store.close()); const hits: string[] = [];
  let task = { id: id(11), status: "open", assignee: "" };
  const engine = new ActionEngine(store, registry, { execute: async (tool, input) => {
    hits.push(tool.name);
    if ([f.denied_asset_id, f.denied_task_id, f.denied_campaign_id, f.denied_page_id].some(id => Object.values(input).includes(id)))
      return { status: "failed", capability: tool.name, error: { code: "client_mismatch" } };
    if (tool.name === "workflow.assign_task") task.assignee = String(input.assignee);
    if (tool.name === "workflow.complete_task") task.status = "complete";
    const queue = tool.name === "conversion.request_approval" ? "console_page_review"
      : tool.name === "campaign.request_approval" ? "console_campaign_launch"
      : "console_approvals";
    return { status: queued.has(tool.name) ? "accepted" : "completed",
      capability: tool.name, data: { client_id: f.client_id, job_id: id(12), task: { ...task },
        page: { id: id(13) }, campaign: { id: id(14) },
        status: "draft", brief_status: "draft", queue, next_cursor: null } };
  } });
  await runMarketingGate((name, input) => engine.call(identity, name, input), f);
  for (const name of config.writes.filter(n => n !== "workflow.create_approval"))
    assert.equal(hits.filter(n => n === name).length, 1, `${name}: replay must not re-execute`);
  assert.equal(store.approvals().length, 1);
  assert.equal(store.approvals()[0].status, "pending");
  assert.ok(!hits.includes("workflow.record_decision"));
});
