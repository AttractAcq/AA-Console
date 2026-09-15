import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as mockServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { financeController } from "../src/onboarding/finance-controller.js";
import { allowed, grants } from "../src/policy/permissions.js";
import { bots } from "../src/shared/types.js";
import { assertFinanceDiscovery, runFinanceGate } from "../scripts/finance-gate.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const campaign = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const identity = { bot: "bot_finance" as const, clients: [client] };
const economics = {
  spend: 1000,
  leads: 1,
  qualified_leads: 1,
  appointments: 1,
  customers: 1,
  revenue: 2000,
  cash_collected: 1500,
  cpl: 1000,
  cpql: 1000,
  cpa: 1000,
  cac: 1000,
  roas: 2,
  cash_roas: 1.5,
  revenue_per_lead: 2000,
  avg_customer_value: 2000,
  currency: "ZAR",
  mixed_currency: false,
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

test("Finance exact discovery equality is 14 and money writes stay stub", (t) => {
  const e = engine(t);
  assertFinanceDiscovery(e.discover(identity).map((x) => x.name));
  // Catalog after PR #47 / Phase 16b only (90 + attach/enable/build).
  // Phase 16c (#46) adds more names.
  assert.equal(registry.length, 93);
  for (const name of financeController.grants)
    assert.equal(registry.find((x) => x.name === name)?.implementation, "real");
  for (const name of [
    "pipeline.record_sale",
    "sales_agents.deploy",
    "attribution.generate_report",
    "attribution.get_content_performance",
  ])
    assert.equal(registry.find((x) => x.name === name)?.implementation, "stub");
  assert.equal(registry.find((t) => t.name === "pipeline.record_sale")?.risk, "HIGH");
  assert.equal(registry.find((t) => t.name === "pipeline.record_sale")?.approval, true);
  assert.equal(grants.bot_finance.includes("economics.*"), false);
  assert.deepEqual([...grants.bot_finance].sort(), [...financeController.grants].sort());
});

test("Finance ceiling rejects broad grants; other bots deny economics tools", (t) => {
  const e = engine(t);
  const broad = {
    ...identity,
    permissions: registry.map((x) => `${x.domain}.*`),
  };
  assertFinanceDiscovery(e.discover(broad).map((x) => x.name));
  for (const bot of bots.filter((b) => b !== "bot_finance"))
    for (const tool of registry.filter((x) => x.domain === "economics"))
      assert.equal(
        allowed({ bot, clients: [client], permissions: ["economics.*"] }, tool),
        false,
      );
});

test("forbidden tools, record_decision, record_sale and cross-client inputs never reach adapter", async (t) => {
  let calls = 0;
  const e = engine(t, {
    execute: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  for (const tool of registry.filter(
    (x) => !financeController.grants.some((n) => n === x.name),
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
  for (const name of financeController.reads) {
    const args =
      name === "workflow.get_task"
        ? { client_id: other, task_id: campaign }
        : { client_id: other };
    assert.equal((await e.call(identity, name, args)).message, "Client scope denied.");
  }
  assert.equal(calls, 0);
});

test("Finance adapter routes all six realized reads with exact fields and correlation", async (t) => {
  const { adapter, seen } = await mockAa(t, (_body, path) => ({
    body: path.includes("campaign") || path.includes("attribution")
      ? {
          client_id: client,
          projection: "acquisition_cohort_economics_v1",
          start_date: "2026-09-01",
          end_date: "2026-10-01",
          exclusive_end: true,
          campaigns: [{ campaign_id: campaign, campaign_ref: "FIN-A", spend: 1000 }],
        }
      : {
          client_id: client,
          projection: "acquisition_cohort_economics_v1",
          start_date: "2026-09-01",
          end_date: "2026-10-01",
          exclusive_end: true,
          economics,
        },
  }));
  const e = engine(t, adapter);
  const args = { client_id: client, start_date: "2026-09-01", end_date: "2026-10-01" };
  for (const name of [
    "economics.get_client_economics",
    "economics.get_campaign_economics",
    "economics.get_costs",
    "economics.get_revenue",
    "economics.get_roi",
    "attribution.get_revenue_attribution",
  ])
    assert.equal((await e.call(identity, name, args)).status, "completed");
  assert.deepEqual(
    seen.map((x) => x.path),
    [
      "/internal/mcp/economics/get-client-economics",
      "/internal/mcp/economics/get-campaign-economics",
      "/internal/mcp/economics/get-costs",
      "/internal/mcp/economics/get-revenue",
      "/internal/mcp/economics/get-roi",
      "/internal/mcp/attribution/get-revenue-attribution",
    ],
  );
  for (const x of seen) {
    assert.equal(x.headers["x-aa-bot-id"], "bot_finance");
    assert.ok(x.headers["x-request-id"]);
    assert.equal(x.body.client_id, client);
  }
});

test("nested cross-client economics responses are malformed, not completed", async (t) => {
  const { adapter } = await mockAa(t, () => ({
    body: { client_id: other, economics },
  }));
  const e = engine(t, adapter);
  const r = await e.call(identity, "economics.get_costs", { client_id: client });
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "malformed_response");
});

test("Gate 13 runs economics reads and a reversible workflow task through the engine", async (t) => {
  const e = engine(t, {
    execute: async (tool: { name: string }, input: Record<string, unknown>) => {
      if (String(input.client_id) === other)
        return { status: "failed", capability: tool.name, error: { code: "client_forbidden" } };
      if (tool.name.startsWith("economics.") || tool.name === "attribution.get_revenue_attribution")
        return {
          status: "completed",
          capability: tool.name,
          data: {
            client_id: client,
            projection: "acquisition_cohort_economics_v1",
            start_date: "2026-09-01",
            end_date: "2026-10-01",
            exclusive_end: true,
            economics,
            campaigns: [],
          },
        };
      return {
        status: "completed",
        capability: tool.name,
        data: {
          client_id: client,
          task: { id: campaign, title: String(input.title ?? "Gate 13"), status: "open" },
        },
      };
    },
  });
  await runFinanceGate((name, args) => e.call(identity, name, args), {
    approved_safe_fixtures: true,
    client_id: client,
    denied_client_id: other,
    denied_client_name: "Attract Acquisition",
    assignee: "bot_finance",
  });
});
