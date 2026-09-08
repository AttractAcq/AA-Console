import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/audit/store.js";
import { ActionEngine } from "../src/policy/engine.js";
import { registry } from "../src/registry/tools.js";
import { grants, permissionMatches, allowed } from "../src/policy/permissions.js";
import type { Identity, Tool } from "../src/shared/types.js";

const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";
const ideaA = "33333333-3333-4333-8333-333333333333";
const production: Identity = { bot: "bot_production", clients: [clientA] };
const finance: Identity = { bot: "bot_finance", clients: [clientA] };
const security: Identity = { bot: "bot_security_devops", clients: [clientA] };

function fixture(discoverStubs = true) {
  const store = new Store(":memory:");
  const engine = new ActionEngine(
    store,
    registry,
    {
      async execute(tool) {
        return { status: "not_implemented", capability: tool.name };
      },
    },
    discoverStubs,
  );
  return { store, engine };
}

test("permission matcher rejects multi-dot, substring, and prefix-without-dot abuse", () => {
  assert.equal(permissionMatches("content.generate_brief", "content.generate_brief"), true);
  assert.equal(permissionMatches("content.*", "content.generate_brief"), true);
  assert.equal(permissionMatches("content.*", "content.submit_asset"), true);
  assert.equal(permissionMatches("content.*", "content.foo.bar"), false);
  assert.equal(permissionMatches("content.*", "content.generate_brief.extra"), false);
  assert.equal(permissionMatches("content.*", "content."), false);
  assert.equal(permissionMatches("content.*", "content"), false);
  assert.equal(permissionMatches("content.*", "contentX.generate_brief"), false);
  assert.equal(permissionMatches("content.generate", "content.generate_brief"), false);
  assert.equal(permissionMatches("content*", "content.generate_brief"), false);
  assert.equal(permissionMatches("*", "content.generate_brief"), false);
  assert.equal(permissionMatches("content.*.x", "content.foo"), false);
  const fake: Tool = {
    ...registry.find((t) => t.name === "content.generate_brief")!,
    name: "content.foo.bar",
    permissions: ["content.foo.bar"],
  };
  assert.equal(allowed("bot_production", fake), false);
});

test("CoS: bot_production has no finance, security, or deploy; bot_finance no content writes; bot_security_devops no client financials / finance_periods", () => {
  for (const tool of [
    "economics.get_costs",
    "economics.get_revenue",
    "economics.get_client_economics",
    "security.get_system_status",
    "security.create_finding",
    "sales_agents.deploy",
  ]) {
    assert.equal(
      grants.bot_production.some((g) => permissionMatches(g, tool)),
      false,
      tool,
    );
  }
  assert.equal(
    grants.bot_production.some((g) => g.includes("finance_periods") || g.includes("deploy")),
    false,
  );
  for (const tool of [
    "content.generate_brief",
    "content.submit_asset",
    "content.approve_asset",
    "content.queue_distribution",
  ]) {
    assert.equal(grants.bot_finance.some((g) => permissionMatches(g, tool)), false, tool);
  }
  for (const tool of [
    "economics.get_costs",
    "economics.get_revenue",
    "attribution.get_revenue_attribution",
  ]) {
    assert.equal(
      grants.bot_security_devops.some((g) => permissionMatches(g, tool)),
      false,
      tool,
    );
  }
  assert.equal(
    grants.bot_security_devops.some((g) => g.includes("finance_periods") || g.includes("finance")),
    false,
  );
  assert.equal(security.bot, "bot_security_devops");
});

test("same-client authorization passes for stubs; other-client is denied before the adapter", async () => {
  const { store, engine } = fixture(true);
  const same = await engine.call(production, "content.list_ideas", { client_id: clientA });
  assert.equal(same.status, "not_implemented");
  const other = await engine.call(production, "content.list_ideas", { client_id: clientB });
  assert.equal(other.status, "rejected");
  assert.equal(other.message, "Client scope denied.");
  store.close();
});

test("permission deny for content.generate_brief happens in the gateway before AA", async () => {
  let calls = 0;
  const store = new Store(":memory:");
  const engine = new ActionEngine(store, registry, {
    async execute() {
      calls += 1;
      return { status: "accepted", capability: "content.generate_brief" };
    },
  });
  const denied = await engine.call(finance, "content.generate_brief", {
    client_id: clientA,
    idea_id: ideaA,
    idempotency_key: "finance-must-not-write",
  });
  assert.equal(denied.status, "rejected");
  assert.equal(denied.message, "Tool unavailable or unauthorized.");
  assert.equal(calls, 0);
  const ok = await engine.call(production, "content.generate_brief", {
    client_id: clientA,
    idea_id: ideaA,
    idempotency_key: "production-brief",
  });
  assert.equal(ok.status, "accepted");
  assert.equal(calls, 1);
  store.close();
});

test("workflow.record_decision stays denied for every Bot including workflow.*", async () => {
  const { store, engine } = fixture(true);
  for (const identity of [production, finance, security, { bot: "bot_chief_of_staff" as const, clients: [clientA] }]) {
    const r = await engine.call(identity, "workflow.record_decision", {
      client_id: clientA,
      approval_id: clientA,
      decision: "approved",
      idempotency_key: "decision",
    });
    assert.equal(r.status, "rejected");
  }
  store.close();
});
